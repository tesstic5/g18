// apps/api/src/routes/withdrawals.ts — fee preview, create, cancel (v4 + docs/19)
import type { FastifyInstance } from 'fastify';
import Decimal from 'decimal.js';
import { withdrawalCreateSchema } from '@casino/shared/validators';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { ok, AppError } from '../lib/core';
import { authMiddleware, rateLimitFactory } from '../middleware';
import { prisma } from '../db/prisma';
import { getNumericSetting, getSetting } from '../services/settings';
import { emitAdmin, shortId } from '../lib/admin-feed';
import { encryptJson, decryptJson } from '../lib/crypto-utils';
import { applyBalanceChange } from '../services/wallet';
import { checkWithdrawalFraud } from '../services/fraud';
import { calculateFee, money } from '@casino/shared/utils/money';
import { freezeActive, freezeMessage } from '../services/recovery';
import { dualControlStage } from '../services/securityPolicy';

/**
 * RECOVERY FREEZE GATE (see routes/recovery.ts).
 *
 * While an account recovery is being worked through, the money rails stay
 * shut: no new payout account (adding one is a hijacker's first move after
 * taking an account over) and no withdrawal request. The hold ends by itself
 * when it lapses; only a super-admin can shorten it, from /panel/recovery.
 */
async function assertNotFrozen(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { withdrawalFrozenUntil: true },
  });
  const until = user?.withdrawalFrozenUntil ?? null;
  if (until && freezeActive(until)) {
    throw new AppError(ERROR_CODES.FIN_RECOVERY_FREEZE, 403, freezeMessage(until));
  }
}

export async function withdrawalRoutes(app: FastifyInstance) {
  // ── PAYOUT ACCOUNTS (D-074: players manage their own withdrawal accounts) ──
  // POST /withdrawals/payout-accounts — create (details stored AES-256-GCM)
  app.post('/payout-accounts', { preHandler: [authMiddleware] }, async (request) => {
    await assertNotFrozen(request.user!.id);
    const body = request.body as {
      type?: string;
      label?: string;
      accountNumber?: string;
      holder?: string;
      bank?: string;
      iban?: string;
    };
    if (!body?.type || !['bank', 'mobile_wallet', 'mobile_money'].includes(body.type)) {
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'Type must be bank, mobile_wallet or mobile_money'
      );
    }
    if (!body.label?.trim() || !body.accountNumber?.trim()) {
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'Label and account number are required'
      );
    }
    // M-12: cap and shape every free-text field (was unbounded → multi-KB
    // blobs in an encrypted column, and arbitrary markup stored for later
    // rendering in admin/payout UIs).
    const accountNumber = body.accountNumber.trim();
    if (accountNumber.length > 64 || !/^[A-Za-z0-9\-\s]+$/.test(accountNumber))
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'Account number must be 1-64 letters, digits, spaces or dashes'
      );
    const capped = (v: string | undefined, max: number) =>
      (v ?? '').trim().slice(0, max);
    if ((body.label ?? '').trim().length > 60)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'Label max 60 characters'
      );
    const details = {
      account_number: accountNumber,
      holder: capped(body.holder, 120),
      bank: capped(body.bank, 120),
      iban: capped(body.iban, 34),
    };
    const acc = await prisma.payoutAccount.create({
      data: {
        userId: request.user!.id,
        type: body.type,
        label: body.label.trim().slice(0, 60),
        accountDetails: encryptJson(details),
      },
    });
    return ok({ id: acc.id, type: acc.type, label: acc.label }, request.requestId!);
  });

  // GET /withdrawals/payout-accounts — list my accounts (decrypted for the owner)
  app.get('/payout-accounts', { preHandler: [authMiddleware] }, async (request) => {
    const rows = await prisma.payoutAccount.findMany({
      where: { userId: request.user!.id },
      orderBy: { createdAt: 'desc' },
    });
    return ok(
      rows.map((a) => {
        let details: Record<string, string> = {};
        try {
          details = decryptJson<Record<string, string>>(a.accountDetails);
        } catch {
          /* corrupt — hide */
        }
        return {
          id: a.id,
          type: a.type,
          label: a.label,
          isLocked: a.isLocked,
          createdAt: a.createdAt,
          details,
        };
      }),
      request.requestId!
    );
  });

  // PATCH /withdrawals/payout-accounts/:id/lock — player locks their own account
  app.patch(
    '/payout-accounts/:id/lock',
    { preHandler: [authMiddleware] },
    async (request) => {
      await assertNotFrozen(request.user!.id);
      const { id } = request.params as { id: string };
      const acc = await prisma.payoutAccount.findFirst({
        where: { id, userId: request.user!.id },
      });
      if (!acc)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Payout account not found');
      const updated = await prisma.payoutAccount.update({
        where: { id },
        data: { isLocked: true, lockedBy: request.user!.id, lockedAt: new Date() },
      });
      return ok({ id: updated.id, isLocked: updated.isLocked }, request.requestId!);
    }
  );

  // GET /withdrawals/fee-preview?amount=
  app.get('/fee-preview', { preHandler: [authMiddleware] }, async (request) => {
    const amount = new Decimal(
      String((request.query as { amount?: string }).amount || '0')
    );
    if (amount.lte(0))
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Invalid amount');
    const feePercent = await getNumericSetting('withdrawal_fee_percent', 2, {
      allowZero: true,
    });
    const fee = calculateFee(amount, feePercent);
    return ok(
      {
        percent: feePercent,
        fee: fee.toDecimalPlaces(2).toNumber(),
        net: amount.minus(fee).toDecimalPlaces(2).toNumber(),
      },
      request.requestId!
    );
  });

  // POST /withdrawals/create — 3/hour/user (docs/14)
  app.post(
    '/create',
    { preHandler: [authMiddleware, rateLimitFactory('withdraw', (r) => r.user!.id)] },
    async (request) => {
      const body = withdrawalCreateSchema.parse(request.body);
      const userId = request.user!.id;
      await assertNotFrozen(userId);
      if (await getSetting<boolean>('ENABLE_KYC')) {
        const kycUser = await prisma.user.findUniqueOrThrow({
          where: { id: userId },
          select: { kycStatus: true },
        });
        if (kycUser.kycStatus !== 'APPROVED') {
          throw new AppError(
            ERROR_CODES.GEN_VALIDATION_ERROR,
            403,
            kycUser.kycStatus === 'PENDING'
              ? 'Your identity check is still under review'
              : 'Complete identity verification before withdrawing'
          );
        }
      }
      const account = await prisma.payoutAccount.findFirst({
        where: { id: body.payoutAccountId, userId },
      });
      if (!account)
        throw new AppError(
          ERROR_CODES.FIN_NO_PAYOUT_ACCOUNT,
          400,
          'Payout account not found'
        );
      if (account.isLocked)
        throw new AppError(
          ERROR_CODES.FIN_PAYOUT_ACCOUNT_LOCKED,
          403,
          'Payout account is locked — contact support'
        );

      const minWithdraw = await getNumericSetting('min_withdrawal', 500);
      const maxWithdraw = await getNumericSetting('max_withdrawal', 100000);
      const feePercent = await getNumericSetting('withdrawal_fee_percent', 2, {
        allowZero: true,
      });
      const amount = money(body.amount);
      if (amount.lt(minWithdraw))
        throw new AppError(
          ERROR_CODES.FIN_BELOW_MIN_WITHDRAW,
          422,
          `Minimum withdrawal is ${minWithdraw}`
        );
      // v1.4.1: admin-controlled global CAP per withdrawal request.
      if (amount.gt(maxWithdraw))
        throw new AppError(
          ERROR_CODES.FIN_ABOVE_MAX_WITHDRAW,
          422,
          `Maximum withdrawal is ${maxWithdraw}`
        );

      const fee = calculateFee(amount, feePercent);
      const net = amount.minus(fee);

      // one locked account rule + review flag for accounts < 24h old (v6 rule 39)
      const accountAge = Date.now() - account.createdAt.getTime();
      const requiresReview = accountAge < 24 * 3600 * 1000;

      // ── DUAL CONTROL (security hardening) ─────────────────────────────
      // Snapshotted at creation: the threshold in force when the player asked
      // is the one this payout is judged by, so an operator raising the limit
      // tomorrow cannot un-approve a payout two people already signed off —
      // and lowering it cannot retroactively demand a second signature on a
      // request that was already compliant when it was made.
      const dualThreshold = await getNumericSetting(
        'withdrawal_dual_control_threshold',
        50000,
        { min: 0 }
      );
      const dualControlRequired =
        dualControlStage({ amount: amount.toNumber(), threshold: dualThreshold, approverId: '' })
          .stage !== 'not-required';

      const withdrawal = await prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
        // FIX: debit the GROSS amount. Previously the wallet was decremented by
        // `net`, so the fee was charged to nobody — the house paid it. It also
        // let a balance of `net` fund a `gross` withdrawal.
        if (wallet.realBalance.lt(amount))
          throw new AppError(
            ERROR_CODES.WALLET_INSUFFICIENT_BALANCE,
            422,
            'Insufficient balance'
          );
        const w = await tx.withdrawal.create({
          data: {
            userId,
            amount: amount.toFixed(2),
            fee: fee.toFixed(2),
            netAmount: net.toFixed(2),
            payoutAccountId: body.payoutAccountId,
            requiresReview,
            dualControlRequired,
          },
        });
        // Gross is held from the wallet now; `net` is what the player receives and
        // `fee` is retained by the house. Refunds (cancel/reject) return GROSS.
        await applyBalanceChange(
          userId,
          'REAL',
          amount.neg(),
          'WITHDRAWAL',
          {
            referenceType: 'withdrawal',
            referenceId: w.id,
            description: `Withdrawal (fee ${fee.toFixed(2)})`,
          },
          tx
        );
        return w;
      });
      // Fraud / admin feed AFTER the debit is committed — never 500 a
      // successful withdrawal (the player would retry and double-hold).
      void checkWithdrawalFraud(userId, Number(amount), accountAge).catch((e) =>
        request.log.error({ err: e }, 'withdrawal fraud check failed')
      );
      try {
        emitAdmin('withdrawal-request', {
          kind: 'withdrawal',
          at: Date.now(),
          userId: shortId(request.user!.id),
          amount: Number(withdrawal.amount),
          netAmount: Number(withdrawal.netAmount),
          status: withdrawal.status,
        });
      } catch (e) {
        request.log.error({ err: e }, 'admin feed withdrawal-request failed');
      }

      return ok(
        {
          id: withdrawal.id,
          status: withdrawal.status,
          netAmount: net.toFixed(2),
          requiresReview,
        },
        request.requestId!
      );
    }
  );

  // POST /withdrawals/:id/cancel — only while Pending
  app.post('/:id/cancel', { preHandler: [authMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const w = await prisma.withdrawal.findFirst({
      where: { id, userId: request.user!.id },
    });
    if (!w) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Withdrawal not found');
    if (w.status !== 'PENDING')
      throw new AppError('GAME_005', 400, 'Only pending withdrawals can be cancelled');
    const refunded = await prisma.$transaction(async (tx) => {
      // Claim PENDING atomically before refunding. An admin completion/rejection
      // racing this request can no longer combine a payout with a refund.
      const claimed = await tx.withdrawal.updateMany({
        where: { id, userId: request.user!.id, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      if (claimed.count !== 1) {
        throw new AppError('GAME_005', 409, 'Withdrawal is already being processed');
      }
      await applyBalanceChange(
        request.user!.id,
        'REAL',
        new Decimal(w.amount.toString()),
        'REFUND',
        {
          referenceType: 'withdrawal',
          referenceId: w.id,
          description: 'Withdrawal cancelled',
        },
        tx
      );
      return tx.withdrawal.findUniqueOrThrow({ where: { id } });
    });
    return ok({ id: refunded.id, status: refunded.status }, request.requestId!);
  });

  // GET /withdrawals — player's withdrawals
  app.get('/', { preHandler: [authMiddleware] }, async (request) => {
    const rows = await prisma.withdrawal.findMany({
      where: { userId: request.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return ok(rows, request.requestId!);
  });
}
