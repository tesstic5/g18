// apps/api/src/routes/user.ts — profile, responsible play (toggle-gated), session stats, favorites
import type { FastifyInstance } from 'fastify';
import { responsiblePlaySchema, displayNameSchema } from '@casino/shared/validators';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { ok, AppError } from '../lib/core';
import { authMiddleware } from '../middleware';
import { prisma } from '../db/prisma';
import { redis } from '../db/redis';
import { revokeAllSessions } from '../services/auth';
import { startOfDay as startOfPlatformDay } from '../lib/day-boundary';

const PERMANENT_EXCLUSION_UNTIL = new Date('9999-12-31T23:59:59.999Z');

export async function userRoutes(app: FastifyInstance) {
  // PATCH /user/profile — language, theme, displayName
  app.patch('/profile', { preHandler: [authMiddleware] }, async (request) => {
    const body = request.body as {
      language?: string;
      theme?: string;
      displayName?: string;
    };
    const data: Record<string, unknown> = {};
    // M-12: language was written verbatim; now a BCP-47-ish code only.
    if (body.language !== undefined) {
      if (
        typeof body.language !== 'string' ||
        !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(body.language)
      )
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Invalid language code'
        );
      data.language = body.language;
    }
    if (body.theme !== undefined) {
      if (body.theme !== 'dark' && body.theme !== 'light')
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Theme must be dark or light'
        );
      data.theme = body.theme;
    }
    // M-12: the profile update bypassed the SIGNUP display-name regex — any
    // string (including =cmd| spreadsheet formulas that later get exported to
    // CSV in player reports) could be written. Apply the same schema here.
    if (body.displayName !== undefined) {
      const parsed = displayNameSchema.safeParse(body.displayName);
      if (!parsed.success)
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          parsed.error.issues[0]?.message ?? 'Invalid display name'
        );
      data.displayName = parsed.data ?? '';
    }
    await prisma.user.update({ where: { id: request.user!.id }, data });
    return ok({ updated: true }, request.requestId!);
  });

  // PATCH /user/favorites — ☆ favorites (docs/16 §9.7)
  app.patch('/favorites', { preHandler: [authMiddleware] }, async (request) => {
    const body = request.body as { gameSlugs?: string[] };
    if (!Array.isArray(body.gameSlugs) || body.gameSlugs.length > 50)
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Invalid favorites');
    // M-18: favorites drive lobby filtering — only canonical, registered game
    // slugs may be stored (was: arbitrary strings → lobby ghost entries and a
    // store-anything column).
    const known = await prisma.gameConfig.findMany({ select: { slug: true } });
    const allowed = new Set(known.map((g) => g.slug));
    const slugs = body.gameSlugs.map((s) => String(s));
    if (slugs.some((s2) => !allowed.has(s2)))
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'Unknown game slug in favorites'
      );
    await prisma.user.update({
      where: { id: request.user!.id },
      data: { favorites: [...new Set(slugs)] },
    });
    return ok({ updated: true }, request.requestId!);
  });

  // PATCH /user/responsible-play — self-exclusion + limits. Safety commitments
  // are always available and cannot be disabled by an operator feature toggle.
  app.patch('/responsible-play', { preHandler: [authMiddleware] }, async (request) => {
    const body = responsiblePlaySchema.parse(request.body);
    const userId = request.user!.id;
    const current = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const data: Record<string, unknown> = {};

    // H-17: responsible-play cooling-off. Lowering a limit (or setting one
    // for the first time) applies IMMEDIATELY; raising or REMOVING a limit is
    // staged for +24h — a tilted player cannot instantly unlock bigger losses.
    // A matured pending change is applied lazily by the guards.
    const stageOrApply = (
      field: 'dailyLossLimit' | 'dailyDepositLimit',
      pendingField: 'pendingLossLimit' | 'pendingDepositLimit',
      pendingAtField: 'pendingLossLimitAt' | 'pendingDepositLimitAt',
      next: number | null
    ) => {
      const cur = current[field] ? Number(current[field]) : null;
      if (next !== null && cur !== null && next <= cur) {
        data[field] = next; // lower → now
        data[pendingField] = null;
        data[pendingAtField] = null;
      } else if (cur === null && next !== null) {
        data[field] = next; // first time setting a limit → now
      } else {
        // raise or removal → 24h cooling-off
        data[pendingField] = next;
        data[pendingAtField] = new Date();
      }
    };
    if (body.dailyLossLimit !== undefined)
      stageOrApply(
        'dailyLossLimit',
        'pendingLossLimit',
        'pendingLossLimitAt',
        body.dailyLossLimit
      );
    if (body.dailyDepositLimit !== undefined)
      stageOrApply(
        'dailyDepositLimit',
        'pendingDepositLimit',
        'pendingDepositLimitAt',
        body.dailyDepositLimit
      );
    if (body.sessionReminderMin !== undefined)
      data.sessionReminderMin = body.sessionReminderMin;

    // Self-exclusion is irrevocable while active. The previous "permanent"
    // duration omitted 60×60 and expired after ~2.43 hours; permanent now uses a
    // far-future date and timed periods can only clear after their end time.
    let exclusionStarted = false;
    if (body.selfExclusionHours !== undefined && body.selfExclusionHours !== null) {
      const hours = body.selfExclusionHours;
      data.selfExcludedUntil =
        hours >= 24 * 365
          ? PERMANENT_EXCLUSION_UNTIL
          : new Date(Date.now() + hours * 60 * 60 * 1000);
      data.status = 'SELF_EXCLUDED';
      exclusionStarted = true;
    } else if (body.selfExclusionHours === null) {
      if (!current.selfExcludedUntil || current.selfExcludedUntil > new Date()) {
        throw new AppError(
          ERROR_CODES.RESP_SELF_EXCLUDED,
          403,
          'An active self-exclusion cannot be cancelled. Access returns automatically after a timed exclusion ends.'
        );
      }
      data.selfExcludedUntil = null;
      data.status = 'ACTIVE';
    }

    await prisma.user.update({ where: { id: userId }, data });
    if (exclusionStarted) {
      await revokeAllSessions(userId, 'self_exclusion');
      const io = (globalThis as { __io?: import('socket.io').Server }).__io;
      io?.in(`user:${userId}`).disconnectSockets(true);
    }
    return ok({ updated: true }, request.requestId!);
  });

  // POST /user/kyc/submit — mark identity check as pending (admin approves).
  app.post('/kyc/submit', { preHandler: [authMiddleware] }, async (request) => {
    const userId = request.user!.id;
    const current = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { kycStatus: true },
    });
    if (current.kycStatus === 'APPROVED')
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 409, 'Already verified');
    if (current.kycStatus === 'PENDING')
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        409,
        'Identity check is already under review'
      );
    await prisma.user.update({
      where: { id: userId },
      data: { kycStatus: 'PENDING' },
    });
    return ok({ kycStatus: 'PENDING' }, request.requestId!);
  });

  // GET /user/session-stats — today's rounds/wins/net/biggest (docs/19 §6, docs/22 §17)
  app.get('/session-stats', { preHandler: [authMiddleware] }, async (request) => {
    const userId = request.user!.id;
    let cached: string | null = null;
    try {
      cached = await redis.get(`session-stats:${userId}`);
    } catch {
      /* recompute */
    }
    if (cached) return ok(JSON.parse(cached), request.requestId!);
    const startOfDay = startOfPlatformDay();
    // M-14: demo + PENDING rounds used to leak into the player's own "today"
    // stats — volume and win-rate moved while a session merely sat open.
    const settledScope = {
      userId,
      demo: false,
      result: { not: 'PENDING' as const },
      createdAt: { gte: startOfDay },
    };
    const [rounds, wins, agg] = await Promise.all([
      prisma.gameRound.count({ where: settledScope }),
      prisma.gameRound.count({
        where: { ...settledScope, result: { in: ['WIN', 'CASHOUT'] } },
      }),
      prisma.gameRound.aggregate({
        where: settledScope,
        _sum: { betAmount: true, payoutAmount: true },
        _max: { payoutAmount: true },
      }),
    ]);
    const stats = {
      roundsPlayed: rounds,
      roundsWon: wins,
      totalWagered: Number(agg._sum.betAmount || 0),
      totalWon: Number(agg._sum.payoutAmount || 0),
      net: Number(agg._sum.payoutAmount || 0) - Number(agg._sum.betAmount || 0),
      biggestWin: Number(agg._max.payoutAmount || 0),
    };
    try {
      await redis.set(`session-stats:${userId}`, JSON.stringify(stats), 'EX', 30);
    } catch {
      /* best effort */
    }
    return ok(stats, request.requestId!);
  });
}
