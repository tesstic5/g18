// apps/api/src/routes/panel-recovery.ts — ACCOUNT RECOVERY CONSOLE (admin).
//
// Mounted under /api/v1/panel, so the shared route→permission map decides who
// may open it (/panel/recovery → permUsers). Approval additionally requires a
// super-admin AND a different admin from the one who verified the evidence —
// the one action in this file that changes who controls an account.
//
// The recovery CODE never appears here. Agents verify claims and approve;
// the claimant collects the code on their own ticket page. That means an
// operator cannot leak it, and a compromised panel session cannot mint one
// for an account it does not already control.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { maskPhone } from '@casino/game-core/mask';
import { ok, AppError } from '../lib/core';
import { writeAudit } from '../lib/audit';
import { emitAdmin, shortId } from '../lib/admin-feed';
import { encryptJson, decryptJson } from '../lib/crypto-utils';
import { prisma } from '../db/prisma';
import { adminAuthMiddleware, requireStepUp } from '../middleware';
import { getNumericSetting } from '../services/settings';
import { notifyUser } from '../services/notify';
import { raiseFraudSignal } from '../services/fraud';
import { loadPlayerContext } from '../services/supportDesk';
import {
  RECOVERY_DEFAULT_CODE_TTL_MIN,
  RECOVERY_DEFAULT_FREEZE_HOURS,
  RECOVERY_EVIDENCE,
  RECOVERY_MAX_FREEZE_HOURS,
  RECOVERY_MIN_CHECKS,
  checklistCount,
  checklistPassed,
  freezeActive,
  freezeMessage,
  freezeWindow,
  generateCode,
  hashCode,
  mergeFreezeUntil,
  sanitizeChecks,
  statusLabel,
  approveGuard,
  type RecoveryStatus,
} from '../services/recovery';

const PAGE_SIZE = 25;

/** Show only what an agent needs to confirm a match — never a full account number. */
function maskAccountNumber(value: string): string {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length >= 7) {
    const tail = digits.slice(-4);
    return `${'•'.repeat(Math.max(0, digits.length - 4))}${tail}`;
  }
  return value.length > 6 ? `${value.slice(0, 2)}••••` : value;
}

function maskedDetails(stored: string): Record<string, string> {
  try {
    const raw = decryptJson<Record<string, string>>(stored);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = maskAccountNumber(String(v));
    return out;
  } catch {
    return { error: 'Unable to decrypt this payout account' };
  }
}

/** Post an agent message into the request's thread (the player reads it there). */
async function postSupportMessage(conversationId: string | null, body: string) {
  if (!conversationId) return;
  await prisma.supportMessage.create({
    data: { conversationId, senderType: 'ADMIN', body },
  });
  await prisma.supportConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date(), adminLastReadAt: new Date() },
  });
  const io = (globalThis as { __io?: import('socket.io').Server }).__io;
  io?.to(`chat:${conversationId}`).emit('chat:message', {
    conversationId,
    message: { senderType: 'ADMIN', body, createdAt: new Date().toISOString() },
  });
}

const verifySchema = z.object({
  checks: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().trim().max(500).optional(),
});

const approveSchema = z.object({
  hours: z.number().int().min(0).max(RECOVERY_MAX_FREEZE_HOURS).optional(),
});

const rejectSchema = z.object({
  reason: z.string().trim().min(4, 'Give the player a reason').max(500),
});

const freezeSchema = z.object({
  hours: z.number().int().min(0).max(RECOVERY_MAX_FREEZE_HOURS),
  reason: z.string().trim().max(300).optional(),
});

export async function panelRecoveryRoutes(app: FastifyInstance) {
  // ── GET /panel/recovery ──────────────────────────────────────────────────
  app.get('/recovery', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const q = request.query as { status?: string; page?: string };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const raw = q.status && q.status !== 'all' ? q.status : null;
    const where =
      raw === 'awaiting'
        ? { status: { in: ['PENDING', 'IN_REVIEW'] as RecoveryStatus[] } }
        : raw === 'closed'
          ? { status: { in: ['REDEEMED', 'REJECTED', 'EXPIRED'] as RecoveryStatus[] } }
          : raw
            ? { status: raw as RecoveryStatus }
            : {};
    const [rows, total] = await Promise.all([
      prisma.recoveryRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          user: {
            select: { id: true, displayName: true, phone: true, status: true, kycStatus: true },
          },
        },
      }),
      prisma.recoveryRequest.count({ where }),
    ]);
    return ok(
      {
        data: rows.map((r) => ({
          id: r.id,
          status: r.status,
          statusLabel: statusLabel(r.status),
          phoneClaimed: maskPhone(r.phoneClaimed),
          userId: r.userId,
          userName: r.user?.displayName ?? null,
          userPhone: r.user ? maskPhone(r.user.phone) : null,
          userStatus: r.user?.status ?? null,
          kycStatus: r.user?.kycStatus ?? null,
          matched: Boolean(r.userId),
          conversationId: r.conversationId,
          hasCode: Boolean(r.codeHash),
          attempts: r.attempts,
          verifiedBy: r.verifiedBy,
          approvedBy: r.approvedBy,
          freezeUntil: r.freezeUntil,
          // Deliberately absent: ticketHash, codeHash, codeEncrypted.
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
        total,
        checklist: RECOVERY_EVIDENCE,
        minChecks: await getNumericSetting('recovery_min_checks', RECOVERY_MIN_CHECKS, { min: 1 }),
      },
      request.requestId!
    );
  });

  // ── GET /panel/recovery/:id ──────────────────────────────────────────────
  app.get('/recovery/:id', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const r = await prisma.recoveryRequest.findUnique({
      where: { id },
      include: { user: { select: { id: true, phone: true, withdrawalFrozenUntil: true } } },
    });
    if (!r) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Recovery request not found');

    const ctx = r.userId ? await loadPlayerContext(r.userId) : null;
    const now = Date.now();

    // Evidence the agent checks the claimant against. Everything here is a
    // fact only the real owner should know.
    const [deposits, devices, logins, payoutAccounts, pendingWithdrawals] = r.userId
      ? await Promise.all([
          prisma.deposit.findMany({
            where: { userId: r.userId },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
              id: true,
              amount: true,
              status: true,
              paymentMethod: true,
              referenceNumber: true,
              senderAccount: true,
              proofObjectKey: true,
              createdAt: true,
            },
          }),
          prisma.userDevice.findMany({
            where: { userId: r.userId },
            orderBy: { lastSeenAt: 'desc' },
            take: 10,
            select: {
              id: true,
              fingerprintHash: true,
              userAgent: true,
              screen: true,
              timezone: true,
              firstIp: true,
              lastIp: true,
              ipCountry: true,
              loginCount: true,
              firstSeenAt: true,
              lastSeenAt: true,
            },
          }),
          prisma.userLoginEvent.findMany({
            where: { userId: r.userId },
            orderBy: { createdAt: 'desc' },
            take: 15,
            select: {
              id: true,
              ip: true,
              ipCountry: true,
              userAgent: true,
              fingerprintHash: true,
              createdAt: true,
            },
          }),
          prisma.payoutAccount.findMany({
            where: { userId: r.userId },
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: {
              id: true,
              type: true,
              label: true,
              accountDetails: true,
              isLocked: true,
              lockedAt: true,
              createdAt: true,
            },
          }),
          prisma.withdrawal.findMany({
            where: { userId: r.userId, status: { in: ['PENDING', 'APPROVED'] } },
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: {
              id: true,
              amount: true,
              netAmount: true,
              status: true,
              requiresReview: true,
              createdAt: true,
            },
          }),
        ])
      : [[], [], [], [], []];

    return ok(
      {
        request: {
          id: r.id,
          status: r.status,
          statusLabel: statusLabel(r.status),
          phoneClaimed: r.phoneClaimed,
          answers: r.answers,
          matched: Boolean(r.userId),
          conversationId: r.conversationId,
          checks: r.checks,
          verifiedBy: r.verifiedBy,
          verifiedAt: r.verifiedAt,
          approvedBy: r.approvedBy,
          approvedAt: r.approvedAt,
          rejectedBy: r.rejectedBy,
          rejectedAt: r.rejectedAt,
          rejectReason: r.rejectReason,
          attempts: r.attempts,
          redeemedAt: r.redeemedAt,
          codeExpiresAt: r.codeExpiresAt,
          freezeUntil: r.freezeUntil,
          freezeActive: freezeActive(r.freezeUntil, now),
          freezeHours: r.freezeHours,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        },
        checklist: RECOVERY_EVIDENCE,
        minChecks: await getNumericSetting('recovery_min_checks', RECOVERY_MIN_CHECKS, { min: 1 }),
        player: ctx
          ? {
              ...ctx,
              phone: ctx.user ? maskPhone(ctx.user.phone) : null,
              accountAgeDays: ctx.user
                ? Math.floor((now - new Date(ctx.user.createdAt).getTime()) / 86_400_000)
                : null,
              withdrawalFrozenUntil: r.user?.withdrawalFrozenUntil ?? null,
            }
          : null,
        evidence: {
          deposits: deposits.map((d) => ({
            id: d.id,
            amount: d.amount.toString(),
            status: d.status,
            method: d.paymentMethod,
            referenceNumber: d.referenceNumber,
            senderAccount: d.senderAccount,
            proofUrl: d.proofObjectKey,
            createdAt: d.createdAt,
          })),
          devices: devices.map((d) => ({
            ...d,
            fingerprintHash: d.fingerprintHash.slice(0, 12),
          })),
          logins,
          payoutAccounts: payoutAccounts.map((a) => ({
            id: a.id,
            type: a.type,
            label: a.label,
            details: maskedDetails(a.accountDetails),
            isLocked: a.isLocked,
            lockedAt: a.lockedAt,
            createdAt: a.createdAt,
          })),
          pendingWithdrawals: pendingWithdrawals.map((w) => ({
            id: w.id,
            amount: w.amount.toString(),
            netAmount: w.netAmount.toString(),
            status: w.status,
            requiresReview: w.requiresReview,
            createdAt: w.createdAt,
          })),
        },
      },
      request.requestId!
    );
  });

  // ── PATCH /panel/recovery/:id/verify ─────────────────────────────────────
  // One admin ticks what matched. Nothing is issued here — this only unlocks
  // the approval step for a DIFFERENT admin.
  app.patch('/recovery/:id/verify', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = verifySchema.safeParse(request.body ?? {});
    if (!parsed.success)
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Invalid verification payload');
    const r = await prisma.recoveryRequest.findUnique({ where: { id } });
    if (!r) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Recovery request not found');
    if (r.redeemedAt || r.status === 'REJECTED' || r.status === 'REDEEMED')
      throw new AppError('RECOVERY_003', 409, 'This request is already closed');

    const min = await getNumericSetting('recovery_min_checks', RECOVERY_MIN_CHECKS, { min: 1 });
    const checks = sanitizeChecks(parsed.data.checks);
    const matched = checklistCount(checks);
    if (!checklistPassed(checks, min))
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        `Tick at least ${min} of the ${RECOVERY_EVIDENCE.length} evidence checks (${matched} matched)`
      );

    // Audit BEFORE the action (repo rule): intent survives a failed write.
    await writeAudit({
      adminId: request.admin!.id,
      action: 'recovery.verify',
      targetType: 'recovery',
      targetId: id,
      beforeState: { status: r.status, checks: r.checks },
      afterState: { status: 'VERIFIED', checks, matched, notes: parsed.data.notes ?? null },
      ip: request.ip,
    });
    const updated = await prisma.recoveryRequest.update({
      where: { id },
      data: {
        status: 'VERIFIED',
        checks: checks as never,
        verifiedBy: request.admin!.id,
        verifiedAt: new Date(),
      },
    });
    await postSupportMessage(
      r.conversationId,
      `Evidence verified (${matched} of ${RECOVERY_EVIDENCE.length}). ` +
        'A second admin must approve before a recovery code is issued.'
    );
    emitAdmin('recovery-verified', {
      id: shortId(id),
      adminId: shortId(request.admin!.id),
      matched,
      at: Date.now(),
    });
    return ok(
      { id: updated.id, status: updated.status, matched, minChecks: min },
      request.requestId!
    );
  });

  // ── PATCH /panel/recovery/:id/approve ────────────────────────────────────
  // DUAL CONTROL: super-admin, and never the admin who verified.
  app.patch('/recovery/:id/approve', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = approveSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Invalid approval payload');
    const r = await prisma.recoveryRequest.findUnique({ where: { id } });
    if (!r) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Recovery request not found');
    if (!r.userId)
      throw new AppError(
        'RECOVERY_002',
        409,
        'No account is attached to this request — there is nothing to recover'
      );

    const guard = approveGuard({
      status: r.status,
      verifiedBy: r.verifiedBy,
      approverId: request.admin!.id,
      isSuperAdmin: Boolean(request.admin!.isSuperAdmin),
      redeemedAt: r.redeemedAt,
      codeExpiresAt: r.codeExpiresAt,
    });
    if (!guard.ok) {
      const status = request.admin!.isSuperAdmin ? 409 : 403;
      throw new AppError('RECOVERY_003', status, guard.reason!);
    }

    const now = Date.now();
    const defaultHours = await getNumericSetting(
      'recovery_freeze_hours',
      RECOVERY_DEFAULT_FREEZE_HOURS,
      { min: 0 }
    );
    const window = freezeWindow(
      now,
      parsed.data.hours === undefined ? defaultHours : parsed.data.hours
    );
    const ttlMinutes = await getNumericSetting(
      'recovery_code_ttl_minutes',
      RECOVERY_DEFAULT_CODE_TTL_MIN,
      { min: 1 }
    );

    const code = generateCode('recovery');
    const codeExpiresAt = new Date(now + ttlMinutes * 60 * 1000);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: r.userId },
      select: { id: true, withdrawalFrozenUntil: true },
    });
    const freezeUntil = mergeFreezeUntil(user.withdrawalFrozenUntil, window.until, now);

    // Audit BEFORE the action (repo rule): intent survives a failed write.
    await writeAudit({
      adminId: request.admin!.id,
      action: 'recovery.approve',
      targetType: 'recovery',
      targetId: id,
      beforeState: { status: r.status, verifiedBy: r.verifiedBy, freezeUntil: r.freezeUntil },
      afterState: {
        status: 'APPROVED',
        userId: r.userId,
        codeExpiresAt: codeExpiresAt.toISOString(),
        freezeUntil: freezeUntil ? freezeUntil.toISOString() : null,
        freezeHours: window.hours,
      },
      ip: request.ip,
    });
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: r.userId! },
        data: {
          withdrawalFrozenUntil: freezeUntil,
          withdrawalFreezeReason: freezeUntil
            ? `Account recovery approved ${new Date(now).toISOString()}`
            : null,
        },
      });
      await tx.recoveryRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedBy: request.admin!.id,
          approvedAt: new Date(now),
          codeHash: hashCode(code),
          // Encrypted, not plaintext: only the ticket holder can read it back.
          codeEncrypted: encryptJson({ code }),
          codeExpiresAt,
          attempts: 0,
          freezeUntil,
          freezeHours: window.hours,
        },
      });
    });

    await postSupportMessage(
      r.conversationId,
      'Approved. Open your ticket page to collect your recovery code — it expires in ' +
        `${ttlMinutes} minutes.` +
        (freezeUntil ? ` ${freezeMessage(freezeUntil)}` : '')
    );
    await notifyUser(
      r.userId,
      'Account recovery approved',
      freezeUntil
        ? freezeMessage(freezeUntil)
        : `Your recovery code is ready on your ticket page. It expires in ${ttlMinutes} minutes.`,
      'security',
      '/profile'
    );
    await raiseFraudSignal(
      r.userId,
      'ACCOUNT_RECOVERY_APPROVED',
      'medium',
      {
        notes: 'Recovery approved — new credentials issued, withdrawals frozen',
        requestId: id,
        verifiedBy: r.verifiedBy,
        approvedBy: request.admin!.id,
        freezeUntil: freezeUntil ? freezeUntil.toISOString() : null,
      },
      { dedupe: false }
    );
    emitAdmin('recovery-approved', {
      id: shortId(id),
      userId: shortId(r.userId),
      freezeUntil: freezeUntil ? freezeUntil.toISOString() : null,
      at: now,
    });

    return ok(
      {
        id,
        status: 'APPROVED',
        codeExpiresAt: codeExpiresAt.toISOString(),
        freezeUntil: freezeUntil ? freezeUntil.toISOString() : null,
        freezeHours: window.hours,
      },
      request.requestId!
    );
  });

  // ── PATCH /panel/recovery/:id/reject ─────────────────────────────────────
  app.patch('/recovery/:id/reject', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = rejectSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        parsed.error.issues[0]?.message ?? 'A reason is required'
      );
    const r = await prisma.recoveryRequest.findUnique({ where: { id } });
    if (!r) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Recovery request not found');
    if (r.status === 'APPROVED')
      throw new AppError(
        'RECOVERY_003',
        409,
        'Approved requests cannot be declined — release the freeze instead if needed'
      );
    if (r.status === 'REJECTED' || r.status === 'REDEEMED')
      throw new AppError('RECOVERY_003', 409, 'This request is already closed');

    await writeAudit({
      adminId: request.admin!.id,
      action: 'recovery.reject',
      targetType: 'recovery',
      targetId: id,
      beforeState: { status: r.status },
      afterState: { status: 'REJECTED', reason: parsed.data.reason },
      ip: request.ip,
    });
    await prisma.recoveryRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectedBy: request.admin!.id,
        rejectedAt: new Date(),
        rejectReason: parsed.data.reason,
        codeHash: null,
        codeEncrypted: null,
        codeExpiresAt: null,
      },
    });
    await postSupportMessage(
      r.conversationId,
      `Your recovery request was declined. Reason: ${parsed.data.reason}. ` +
        'You can reply here and an agent will review it again.'
    );
    if (r.userId) {
      await notifyUser(
        r.userId,
        'Recovery request declined',
        parsed.data.reason,
        'security',
        '/support'
      );
    }
    emitAdmin('recovery-rejected', { id: shortId(id), at: Date.now() });
    return ok({ id, status: 'REJECTED' }, request.requestId!);
  });

  // ── POST /panel/recovery/:id/freeze ──────────────────────────────────────
  // Extend, shorten to zero (release), or set the hold manually. Super-admin
  // only: this is the control that keeps a hijacked account's money still.
  app.post(
    '/recovery/:id/freeze',
    // STEP-UP: releasing a freeze early is the one control standing between a
    // hijacked account and its balance.
    { preHandler: [adminAuthMiddleware, requireStepUp] },
    async (request) => {
    const { id } = request.params as { id: string };
    if (!request.admin!.isSuperAdmin)
      throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 403, 'Super-admin only');
    const parsed = freezeSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        `hours must be 0–${RECOVERY_MAX_FREEZE_HOURS}`
      );
    const r = await prisma.recoveryRequest.findUnique({ where: { id } });
    if (!r) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Recovery request not found');
    if (!r.userId)
      throw new AppError('RECOVERY_002', 409, 'No account is attached to this request');

    const now = Date.now();
    const window = freezeWindow(now, parsed.data.hours);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: r.userId },
      select: { withdrawalFrozenUntil: true },
    });
    const freezeUntil = window.until
      ? mergeFreezeUntil(user.withdrawalFrozenUntil, window.until, now)
      : null;

    // Audit BEFORE the action (repo rule): intent survives a failed write.
    await writeAudit({
      adminId: request.admin!.id,
      action: freezeUntil ? 'recovery.freeze.set' : 'recovery.freeze.release',
      targetType: 'recovery',
      targetId: id,
      beforeState: { freezeUntil: user.withdrawalFrozenUntil },
      afterState: {
        freezeUntil: freezeUntil ? freezeUntil.toISOString() : null,
        reason: parsed.data.reason ?? null,
      },
      ip: request.ip,
    });
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: r.userId! },
        data: {
          withdrawalFrozenUntil: freezeUntil,
          withdrawalFreezeReason: freezeUntil
            ? parsed.data.reason ?? 'Withdrawal hold set by super-admin'
            : null,
        },
      });
      await tx.recoveryRequest.update({
        where: { id },
        data: {
          freezeUntil,
          freezeHours: freezeUntil ? window.hours : 0,
          freezeReleasedAt: freezeUntil ? null : new Date(now),
        },
      });
    });
    await postSupportMessage(
      r.conversationId,
      freezeUntil
        ? `Withdrawal protection extended. ${freezeMessage(freezeUntil)}`
        : 'Withdrawal protection has been lifted — you can move funds normally again.'
    );
    await notifyUser(
      r.userId,
      freezeUntil ? 'Withdrawals on hold' : 'Withdrawals released',
      freezeUntil
        ? freezeMessage(freezeUntil)
        : 'The hold on your withdrawals has been lifted.',
      'security',
      '/wallet'
    );
    emitAdmin('recovery-freeze', {
      id: shortId(id),
      freezeUntil: freezeUntil ? freezeUntil.toISOString() : null,
      at: now,
    });
    return ok(
      { id, freezeUntil: freezeUntil ? freezeUntil.toISOString() : null },
      request.requestId!
    );
  });
}
