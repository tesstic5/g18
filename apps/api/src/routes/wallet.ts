// apps/api/src/routes/wallet.ts — balance, transactions (v4 + docs/19 §23 pagination)
import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/core';
import { authMiddleware } from '../middleware';
import { prisma } from '../db/prisma';
import { getSpendPriority } from '../services/wallet';
import { getNumericSetting } from '../services/settings';

export async function walletRoutes(app: FastifyInstance) {
  // GET /wallet/limits — PUBLIC operational bounds (v1.4.1): the deposit and
  // withdrawal sheets render Min/Max hints + clamp their inputs from this, so
  // admin changes take effect client-side without a hard reload. Intentionally
  // no auth: these are UI facts, not secrets (packages/fee-preview are public too).
  app.get('/limits', async (request) => {
    const [minDeposit, maxDeposit, minWithdrawal, maxWithdrawal, feePct] =
      await Promise.all([
        getNumericSetting('min_deposit', 10, { allowZero: true }),
        getNumericSetting('max_deposit', 100000),
        getNumericSetting('min_withdrawal', 500),
        getNumericSetting('max_withdrawal', 100000),
        getNumericSetting('withdrawal_fee_percent', 2, { allowZero: true }),
      ]);
    return ok(
      {
        minDeposit,
        maxDeposit,
        minWithdrawal,
        maxWithdrawal,
        withdrawalFeePercent: feePct,
        currencySymbol: process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨',
      },
      request.requestId!
    );
  });

  // GET /wallet/balance — fast path (Redis cache note: source of truth is DB)
  app.get('/balance', { preHandler: [authMiddleware] }, async (request) => {
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId: request.user!.id },
    });
    // M-11: the client deducts optimistically BEFORE the server answers; it
    // must walk wallets in the server's configured order, or the displayed
    // post-bet balance disagrees with the settled one.
    const spendPriority = await getSpendPriority();
    return ok(
      {
        real: wallet.realBalance.toString(),
        bonus: wallet.bonusBalance.toString(),
        gifted: wallet.giftedBalance.toString(),
        locked: wallet.lockedBalance.toString(),
        spendPriority,
      },
      request.requestId!
    );
  });

  // GET /wallet/transactions?page=&pageSize=&type=&from=&to=
  app.get('/transactions', { preHandler: [authMiddleware] }, async (request) => {
    const q = request.query as {
      page?: string;
      pageSize?: string;
      type?: string;
      from?: string;
      to?: string;
    };
    const page = Math.max(1, parseInt(q.page || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize || '20')));
    const where = {
      userId: request.user!.id,
      ...(q.type ? { type: q.type as never } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.transaction.count({ where }),
    ]);
    return ok(
      {
        data: rows.map((t) => ({
          id: t.id,
          type: t.type,
          walletType: t.walletType,
          amount: t.amount.toString(),
          balanceBefore: t.balanceBefore.toString(),
          balanceAfter: t.balanceAfter.toString(),
          referenceType: t.referenceType,
          referenceId: t.referenceId,
          description: t.description,
          createdAt: t.createdAt,
        })),
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
          hasNext: page * pageSize < total,
          hasPrev: page > 1,
        },
      },
      request.requestId!
    );
  });
}
