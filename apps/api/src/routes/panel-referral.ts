// apps/api/src/routes/panel-referral.ts — admin management of referral AGENT
// accounts. Super-admin only: agents can see player financials, so creating
// one is a privileged operation (audited via the standard admin audit trail).
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { z } from 'zod';
import { ok, AppError } from '../lib/core';
import { adminAuthMiddleware } from '../middleware';
import { prisma } from '../db/prisma';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { normalizePhone } from '@casino/shared/utils/phone';

const createSchema = z.object({
  phone: z.string().min(3).max(32),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(48).optional(),
});

function requireSuperAdmin(request: { admin?: { isSuperAdmin: boolean } }) {
  if (!request.admin?.isSuperAdmin)
    throw new AppError(ERROR_CODES.PANEL_FORBIDDEN, 403, 'Super-admin only');
}

export async function panelReferralRoutes(app: FastifyInstance) {
  // GET /panel/referral-users — list agents with their invite stats
  app.get('/referral-users', { preHandler: [adminAuthMiddleware] }, async (request) => {
    requireSuperAdmin(request);
    const agents = await prisma.user.findMany({
      where: { isReferralAgent: true },
      select: {
        id: true,
        phone: true,
        displayName: true,
        status: true,
        referralCode: true,
        createdAt: true,
        referralCommissionPaidUpTo: true,
        _count: { select: { referrals: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const ids = agents.map((a) => a.id);
    const commissions = ids.length
      ? await prisma.transaction.groupBy({
          by: ['userId'],
          where: { userId: { in: ids }, type: 'REFERRAL_COMMISSION' },
          _sum: { amount: true },
        })
      : [];
    const commMap = new Map(commissions.map((c) => [c.userId, Number(c._sum.amount ?? 0)]));
    return ok(
      {
        agents: agents.map((a) => ({
          ...a,
          inviteUrl: `${process.env.FRONTEND_URL || ''}/signup?ref=${a.referralCode}`,
          totalReferred: a._count.referrals,
          commissionPaid: commMap.get(a.id) ?? 0,
        })),
      },
      request.requestId!
    );
  });

  // POST /panel/referral-users — create a referral agent account
  app.post('/referral-users', { preHandler: [adminAuthMiddleware] }, async (request) => {
    requireSuperAdmin(request);
    const body = createSchema.parse(request.body);
    const phone = normalizePhone(body.phone) ?? body.phone.trim();

    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing)
      throw new AppError(
        ERROR_CODES.AUTH_PHONE_TAKEN,
        409,
        'A user with this phone already exists'
      );

    const agent = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          phone,
          passwordHash: await bcrypt.hash(body.password, 12),
          displayName: body.displayName ?? `Agent ${phone.slice(-4)}`,
          isReferralAgent: true,
          status: 'ACTIVE',
          // Codes are stored UPPERCASE (signup looks up ref.toUpperCase()); the
          // schema default cuid() is lowercase and would never match a link.
          referralCode: crypto.randomBytes(6).toString('hex').toUpperCase(),
        },
      });
      await tx.wallet.create({ data: { userId: created.id } });
      return created;
    });

    return ok(
      {
        id: agent.id,
        phone: agent.phone,
        referralCode: agent.referralCode,
        inviteUrl: `${process.env.FRONTEND_URL || ''}/signup?ref=${agent.referralCode}`,
      },
      request.requestId!
    );
  });

  // POST /panel/referral-users/:id/toggle — activate / suspend an agent
  app.post(
    '/referral-users/:id/toggle',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      requireSuperAdmin(request);
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const agent = await prisma.user.findUnique({
        where: { id },
        select: { id: true, isReferralAgent: true, status: true },
      });
      if (!agent || !agent.isReferralAgent)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND ?? 'GEN_NOT_FOUND', 404, 'Agent not found');
      const updated = await prisma.user.update({
        where: { id },
        data: { status: agent.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' },
        select: { id: true, status: true },
      });
      return ok({ ...updated }, request.requestId!);
    }
  );

  // PATCH /panel/referral-users/:id/bonus — per-agent referee signup bonus
  // (enabled + amount credited to the new player's BONUS wallet at signup).
  app.patch(
    '/referral-users/:id/bonus',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      requireSuperAdmin(request);
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const body = z.object({
        enabled: z.boolean(),
        amount: z.number().min(0).max(100000),
      }).parse(request.body);
      const agent = await prisma.user.findUnique({
        where: { id },
        select: { id: true, isReferralAgent: true },
      });
      if (!agent || !agent.isReferralAgent)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Agent not found');
      const updated = await prisma.user.update({
        where: { id },
        data: {
          referralSignupBonusEnabled: body.enabled,
          referralSignupBonusAmount: body.amount,
        },
        select: { id: true, referralSignupBonusEnabled: true, referralSignupBonusAmount: true },
      });
      return ok({ ...updated, referralSignupBonusAmount: Number(updated.referralSignupBonusAmount) }, request.requestId!);
    }
  );

  // DELETE /panel/referral-users/:id — REMOVE an agent. Never hard-deletes the
  // user row: referred players, wallet and ledger history reference it. Instead
  // the agent flag is stripped and the account suspended, so /referral/login
  // stops working immediately (referralAuthMiddleware requires both) while all
  // historical data stays intact.
  app.delete(
    '/referral-users/:id',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      requireSuperAdmin(request);
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const agent = await prisma.user.findUnique({
        where: { id },
        select: { id: true, isReferralAgent: true },
      });
      if (!agent || !agent.isReferralAgent)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Agent not found');
      await prisma.user.update({
        where: { id },
        data: { isReferralAgent: false, status: 'SUSPENDED' },
      });
      return ok({ removed: true }, request.requestId!);
    }
  );

  // POST /panel/referral-users/:id/reset-password — set a new login password
  app.post(
    '/referral-users/:id/reset-password',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      requireSuperAdmin(request);
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const body = z.object({ password: z.string().min(8).max(128) }).parse(request.body);
      const agent = await prisma.user.findUnique({
        where: { id },
        select: { id: true, isReferralAgent: true },
      });
      if (!agent || !agent.isReferralAgent)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Agent not found');
      await prisma.user.update({
        where: { id },
        data: { passwordHash: await bcrypt.hash(body.password, 12) },
      });
      return ok({ reset: true }, request.requestId!);
    }
  );
}
