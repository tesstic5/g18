// apps/api/src/routes/referral.ts — code, stats (v4)
import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/core';
import { authMiddleware } from '../middleware';
import { prisma } from '../db/prisma';
import { getSettings } from '../services/settings';

/** The bonus economics, in one place, so the UI can never hardcode them. */
async function referralBonusInfo() {
  const s = await getSettings();
  return {
    enabled: s.referral_bonus_enabled === true,
    referrerBonus: Number(s.referral_bonus_referrer) || 0,
    refereeBonus: Number(s.referral_bonus_referee) || 0,
  };
}

export async function referralRoutes(app: FastifyInstance) {
  // PUBLIC: the signed-out /referral page needs the real numbers for its
  // "invite a friend" pitch. Deliberately exposes no per-user data and no code
  // lookup — only the operator's published bonus amounts.
  app.get('/info', async (request) => {
    return ok(await referralBonusInfo(), request.requestId!);
  });

  app.get('/code', { preHandler: [authMiddleware] }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user!.id },
      select: { referralCode: true },
    });
    return ok(
      {
        code: user.referralCode,
        url: `${process.env.FRONTEND_URL || ''}/signup?ref=${user.referralCode}`,
        // Was hardcoded as ₨25 / ₨10 in the UI, so the page lied whenever an
        // operator changed the settings.
        ...(await referralBonusInfo()),
      },
      request.requestId!
    );
  });

  app.get('/stats', { preHandler: [authMiddleware] }, async (request) => {
    const [totalReferred, earned] = await Promise.all([
      prisma.user.count({ where: { referredById: request.user!.id } }),
      prisma.transaction.aggregate({
        where: { userId: request.user!.id, type: 'BONUS_REFERRAL' },
        _sum: { amount: true },
      }),
    ]);
    return ok(
      { totalReferred, totalEarned: Number(earned._sum.amount || 0) },
      request.requestId!
    );
  });
}
