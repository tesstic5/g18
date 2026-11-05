// apps/api/src/routes/referralPanel.ts — referral AGENT console API.
//
// Agents are user accounts flagged isReferralAgent, created from
// /panel/referral-users. They log in ONLY here (own JWT issuer/role) and get a
// READ-ONLY dashboard of the players who signed up with their referralCode.
// The invite link is /signup?ref=<their referralCode> — signup auto-applies it
// and referredById is immutable afterwards (no endpoint ever rewrites it).
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { ok, AppError } from '../lib/core';
import { prisma } from '../db/prisma';
import { rateLimitFactory, referralAuthMiddleware } from '../middleware';
import { getJwtPrivateKey } from '../lib/jwt-keys';
import { JWT_ISSUER_REFERRAL, JWT_ROLE_REFERRAL } from '../lib/jwt-claims';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { normalizePhone } from '@casino/shared/utils/phone';

const loginSchema = z.object({
  phone: z.string().min(3).max(32),
  password: z.string().min(1).max(128),
});

export async function referralPanelRoutes(app: FastifyInstance) {
  // ── LOGIN (public, rate-limited per IP) ──────────────────────────────────
  app.post('/login', { preHandler: [rateLimitFactory('login', (r) => r.ip)] }, async (request) => {
    const body = loginSchema.parse(request.body);
    const phone = normalizePhone(body.phone) ?? body.phone.trim();
    const user = await prisma.user.findUnique({
      where: { phone },
      select: { id: true, passwordHash: true, isReferralAgent: true, status: true, displayName: true, referralCode: true },
    });
    // Same error for "no such account" and "not an agent" — do not reveal which.
    const fail = () =>
      new AppError(ERROR_CODES.AUTH_INVALID_CREDENTIALS ?? 'AUTH_INVALID', 401, 'Invalid phone or password');
    if (!user || !user.isReferralAgent) throw fail();
    if (!(await bcrypt.compare(body.password, user.passwordHash))) throw fail();
    if (user.status !== 'ACTIVE')
      throw new AppError(ERROR_CODES.AUTH_ACCOUNT_SUSPENDED ?? 'AUTH_ACCOUNT_SUSPENDED', 403, 'Account is not active');

    const token = jwt.sign({ sub: user.id, role: JWT_ROLE_REFERRAL }, getJwtPrivateKey(), {
      algorithm: 'RS256',
      expiresIn: '8h',
      issuer: JWT_ISSUER_REFERRAL,
    });
    return ok(
      {
        token,
        expiresIn: 8 * 3600,
        agent: {
          id: user.id,
          displayName: user.displayName,
          referralCode: user.referralCode,
          inviteUrl: `${process.env.FRONTEND_URL || ''}/signup?ref=${user.referralCode}`,
        },
      },
      request.requestId!
    );
  });

  // ── ME — own profile + the one invite link ────────────────────────────────
  app.get('/me', { preHandler: [referralAuthMiddleware] }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user!.id },
      select: {
        id: true,
        displayName: true,
        phone: true,
        referralCode: true,
        createdAt: true,
        referralSignupBonusEnabled: true,
        referralSignupBonusAmount: true,
      },
    });
    return ok(
      {
        ...user,
        referralSignupBonusAmount: Number(user.referralSignupBonusAmount),
        inviteUrl: `${process.env.FRONTEND_URL || ''}/signup?ref=${user.referralCode}`,
      },
      request.requestId!
    );
  });

  // ── DASHBOARD — read-only stats of everyone who signed up via my link ────
  app.get('/dashboard', { preHandler: [referralAuthMiddleware] }, async (request) => {
    const agentId = request.user!.id;
    const agent = await prisma.user.findUniqueOrThrow({
      where: { id: agentId },
      select: { referralCode: true, referralCommissionPaidUpTo: true },
    });

    const referred = await prisma.user.findMany({
      where: { referredById: agentId },
      select: { id: true, phone: true, displayName: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const ids = referred.map((u) => u.id);

    // Per-user aggregates. Volume/payout come from GameRound (settled,
    // real-money only — same definitions as the admin reports, docs/SYSTEM.md);
    // deposits from the ledger DEPOSIT rows; balance from the Wallet.
    const [rounds, deposits, wallets] = ids.length
      ? await Promise.all([
          prisma.gameRound.groupBy({
            by: ['userId'],
            where: { userId: { in: ids }, demo: false, result: { not: 'PENDING' } },
            _sum: { betAmount: true, payoutAmount: true },
            _count: { id: true },
          }),
          prisma.transaction.groupBy({
            by: ['userId'],
            where: { userId: { in: ids }, type: 'DEPOSIT' },
            _sum: { amount: true },
          }),
          prisma.wallet.findMany({
            where: { userId: { in: ids } },
            select: { userId: true, realBalance: true, bonusBalance: true, giftedBalance: true },
          }),
        ])
      : [[], [], []];

    const roundMap = new Map(rounds.map((r) => [r.userId, r]));
    const depMap = new Map(deposits.map((d) => [d.userId, d._sum.amount ?? 0]));
    const walletMap = new Map(wallets.map((w) => [w.userId, w]));

    const maskPhone = (p: string) => (p.length > 6 ? `${p.slice(0, 4)}****${p.slice(-2)}` : '****');

    const users = referred.map((u) => {
      const r = roundMap.get(u.id);
      const wagered = Number(r?._sum.betAmount ?? 0);
      const paidOut = Number(r?._sum.payoutAmount ?? 0);
      const w = walletMap.get(u.id);
      return {
        id: u.id,
        phone: maskPhone(u.phone),
        displayName: u.displayName,
        joinedAt: u.createdAt,
        roundsPlayed: r?._count.id ?? 0,
        totalDeposited: Number(depMap.get(u.id) ?? 0),
        totalWagered: wagered,
        totalPayout: paidOut,
        netSpend: wagered - paidOut, // player loss = house GGR; commission base
        balance: w
          ? Number(w.realBalance) + Number(w.bonusBalance) + Number(w.giftedBalance)
          : 0,
      };
    });

    const totals = users.reduce(
      (a, u) => ({
        users: a.users + 1,
        roundsPlayed: a.roundsPlayed + u.roundsPlayed,
        totalDeposited: a.totalDeposited + u.totalDeposited,
        totalWagered: a.totalWagered + u.totalWagered,
        totalPayout: a.totalPayout + u.totalPayout,
        netSpend: a.netSpend + u.netSpend,
      }),
      { users: 0, roundsPlayed: 0, totalDeposited: 0, totalWagered: 0, totalPayout: 0, netSpend: 0 }
    );

    // Commission earned so far (sum of REFERRAL_COMMISSION ledger rows).
    const commission = await prisma.transaction.aggregate({
      where: { userId: agentId, type: 'REFERRAL_COMMISSION' },
      _sum: { amount: true },
    });

    return ok(
      {
        inviteUrl: `${process.env.FRONTEND_URL || ''}/signup?ref=${agent.referralCode}`,
        referralCode: agent.referralCode,
        totals,
        commissionEarned: Number(commission._sum.amount ?? 0),
        commissionPaidUpTo: agent.referralCommissionPaidUpTo,
        users,
      },
      request.requestId!
    );
  });
}
