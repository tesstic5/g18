// apps/api/src/routes/panel-games.ts — game config editor endpoints.
// validateConfig runs in the SAME request as the save (docs/20 rule 4) → 422 on invalid.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { ok, AppError } from '../lib/core';
import { adminAuthMiddleware } from '../middleware';
import { writeAudit } from '../lib/audit';
import { prisma } from '../db/prisma';
import { redis, keys } from '../db/redis';
import { saveGameConfig, validateConfig } from '../services/gameConfig';
import { DIFFICULTY_AWARE_SLUGS, DIFFICULTY_CAPABLE_SLUGS } from '../engine/difficulty';
import {
  validateGameConfigJson,
  patchTouchesOdds,
  usesGenericPayoutWeights,
} from '../engine/configValidation';

const gameConfigPatchSchema = z
  .object({
    isActive: z.boolean().optional(),
    isFeatured: z.boolean().optional(),
    demoEnabled: z.boolean().optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(1000).nullable().optional(),
    thumbnailUrl: z.string().max(500).nullable().optional(),
    category: z.array(z.string().min(1).max(40)).max(20).optional(),
    tags: z.array(z.string().min(1).max(40)).max(30).optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
    baseRtp: z.number().finite().min(1).max(99).optional(),
    winRate: z.number().finite().min(1).max(98).optional(),
    maxWinMultiplier: z.number().finite().positive().max(10_000_000).optional(),
    minBet: z.number().finite().positive().max(1_000_000_000).optional(),
    defaultPayout: z.number().finite().nonnegative().max(10_000_000).optional(),
    animationSpeed: z.number().finite().min(0.1).max(5).optional(),
    configJson: z.record(z.string(), z.unknown()).optional(),
    /** Per-game difficulty override; null clears it back to the platform default. */
    difficulty: z.enum(['easy', 'normal', 'hard', 'impossible']).nullable().optional(),
  })
  .strict();

export async function panelGameRoutes(app: FastifyInstance) {
  // GET /panel/games — all games with current config
  app.get('/games', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const games = await prisma.gameConfig.findMany({ orderBy: { sortOrder: 'asc' } });
    return ok(games, request.requestId!);
  });

  // GET /panel/games/:slug — full config + live stats (docs/19 §17 right column)
  app.get('/games/:slug', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { slug } = request.params as { slug: string };
    const game = await prisma.gameConfig.findUnique({ where: { slug } });
    if (!game) throw new AppError(ERROR_CODES.GAME_NOT_FOUND, 404, 'Game not found');
    const forceCapable = DIFFICULTY_AWARE_SLUGS.includes(slug);
    const difficultyCapable = DIFFICULTY_CAPABLE_SLUGS.includes(slug);
    return ok(
      {
        ...game,
        // Force verdicts: one-shot games only (a shared round can never be
        // force-rendered for thousands of simultaneous bettors). Difficulty:
        // one-shots steer win frequency; crash games steer the takeoff-blast
        // gate; WinGo steers via lock-time book fade. Session games exempt.
        outcomeOverridesEnabled: forceCapable,
        difficultyCapable,
        difficulty: (game.configJson as { difficulty?: unknown })?.difficulty ?? null,
      },
      request.requestId!
    );
  });

  // PATCH /panel/games/:slug — SAVE with in-request validation (docs/20 rule 4)
  app.patch('/games/:slug', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { slug } = request.params as { slug: string };
    const parsed = gameConfigPatchSchema.parse(request.body);
    if (parsed.difficulty !== undefined && !DIFFICULTY_CAPABLE_SLUGS.includes(slug))
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'Difficulty applies to one-shot, crash and WinGo only (mines, tower, stairs, hi-lo are exempt by design)'
      );
    const { difficulty, ...rest } = parsed;
    const body: Record<string, unknown> = {
      ...rest,
      ...(parsed.baseRtp !== undefined
        ? { houseEdge: +(100 - parsed.baseRtp).toFixed(2) }
        : {}),
    };
    const current = await prisma.gameConfig.findUniqueOrThrow({ where: { slug } });
    // Difficulty rides INSIDE configJson (schema-free), so merges stay atomic
    // and the engine reads a single object per bet.
    if (difficulty !== undefined) {
      const cj = (current.configJson ?? {}) as Record<string, unknown>;
      const merged =
        difficulty === null
          ? Object.fromEntries(Object.entries(cj).filter(([k]) => k !== 'difficulty'))
          : { ...cj, difficulty };
      body.configJson = merged;
    }

    // Odds validation is skipped for hide/Hot/rename so a leftover
    // payout_weights table cannot trap the game in the lobby. Crash games
    // skip the generic winRate×weights check (they never pay from it).
    const candidate = {
      winRate:
        body.winRate !== undefined ? Number(body.winRate) : Number(current.winRate),
      maxWinMultiplier:
        body.maxWinMultiplier !== undefined
          ? Number(body.maxWinMultiplier)
          : Number(current.maxWinMultiplier),
      payoutWeights: (
        body.configJson as
          { payout_weights?: Array<{ multiplier: number; weight: number }> } | undefined
      )?.payout_weights ??
        (
          current.configJson as {
            payout_weights?: Array<{ multiplier: number; weight: number }>;
          }
        )?.payout_weights ?? [{ multiplier: Number(current.defaultPayout), weight: 1 }],
    };
    let calculatedRtp = 0;
    let houseEdge = 0;
    let rtpTable: Record<string, number> | null = null;
    let warnings: { field: string; message: string }[] = [];
    if (patchTouchesOdds(body)) {
      if (usesGenericPayoutWeights(slug)) {
        const result = validateConfig(candidate);
        if (!result.valid) {
          throw new AppError(ERROR_CODES.CONF_EXCEEDS_CEILING, 422, result.error!, {
            calculatedRtp: result.calculatedRtp,
          });
        }
        calculatedRtp = result.calculatedRtp;
        houseEdge = result.houseEdge;
      }
      // v1.3.5·§5: non-blocking per-choice odds feedback computed from THE
      // MERGED configJson (incl. difficulty + weights) — tells the operator
      // when one bet drifts far from its usual payback BEFORE they save garbage.
      const strictCheck = validateGameConfigJson(
        slug,
        (body.configJson as Record<string, unknown> | undefined) ??
          (current.configJson as Record<string, unknown>) ??
          {},
        candidate.maxWinMultiplier
      );
      if (!strictCheck.ok) {
        const first = strictCheck.issues[0]!;
        throw new AppError(
          ERROR_CODES.CONF_EXCEEDS_CEILING,
          422,
          `${first.field}: ${first.message}`,
          { issues: strictCheck.issues }
        );
      }
      rtpTable = strictCheck.rtpTable ?? null;
      warnings = strictCheck.warnings ?? [];
    }

    // audit BEFORE the action (rule 25)
    await writeAudit({
      adminId: request.admin!.id,
      action: 'game.config.update',
      targetType: 'game',
      targetId: slug,
      beforeState: {
        winRate: Number(current.winRate),
        baseRtp: Number(current.baseRtp),
        forceOverride: current.forceOverride,
        forceRoundsLeft: current.forceRoundsLeft,
      },
      afterState: { ...body, difficulty: difficulty ?? undefined },
      ip: request.ip,
    });

    const saved = await saveGameConfig(slug, body, request.admin!.id);
    return ok(
      {
        slug: saved.slug,
        updatedAt: saved.updatedAt,
        calculatedRtp,
        houseEdge,
        // §5: what the saved odds actually promise per bet choice, plus any
        // "you're robbing them / giving it away" advisories (non-blocking).
        rtpTable,
        warnings,
      },
      request.requestId!
    );
  });

  // PATCH /panel/games/:slug/force — force override (rounds + max payout)
  // POST /panel/games/:slug/clear-history — admin/test utility: wipes game rounds +
  // rolling stats for one game (used by the E2E harness to get a clean win-rate slate)
  app.post(
    '/games/:slug/clear-history',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const body = request.body as { confirm?: boolean };
      if (!body?.confirm)
        throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Must confirm');
      await prisma.gameRound.deleteMany({ where: { gameSlug: slug } });
      await redis.del(keys.gameStats(slug));
      await writeAudit({
        adminId: request.admin!.id,
        action: 'game.clear_history',
        targetType: 'game',
        targetId: slug,
        ip: request.ip,
      });
      return ok({ cleared: true }, request.requestId!);
    }
  );

  const forceSchema = z
    .object({
      forceOverride: z.enum(['NONE', 'FORCE_WIN', 'FORCE_LOSE']),
      rounds: z.number().int().min(0).max(100000).optional(),
      forceRoundsLeft: z.number().int().min(0).max(100000).optional(),
      maxPayout: z
        .number()
        .finite()
        .positive()
        .max(1_000_000_000)
        .nullable()
        .optional(),
    })
    .strict();

  app.patch(
    '/games/:slug/force',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { slug } = request.params as { slug: string };
      if (!DIFFICULTY_AWARE_SLUGS.includes(slug))
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Force overrides apply to one-shot games only (session and shared-round games are exempt by design)'
        );
      const body = forceSchema.parse(request.body);
      const current = await prisma.gameConfig.findUniqueOrThrow({ where: { slug } });
      await writeAudit({
        adminId: request.admin!.id,
        action: 'game.force_override',
        targetType: 'game',
        targetId: slug,
        beforeState: {
          forceOverride: current.forceOverride,
          forceRoundsLeft: current.forceRoundsLeft,
        },
        afterState: body,
        ip: request.ip,
      });
      const updated = await prisma.gameConfig.update({
        where: { slug },
        data: {
          forceOverride: body.forceOverride,
          // accept both `rounds` (API contract) and `forceRoundsLeft` (admin UI sends this)
          forceRoundsLeft:
            body.forceOverride === 'NONE'
              ? 0
              : Math.max(0, Math.floor(body.rounds ?? body.forceRoundsLeft ?? 0)),
          forceMaxPayout:
            body.forceOverride === 'NONE'
              ? null
              : body.maxPayout
                ? String(body.maxPayout)
                : null,
          updatedBy: request.admin!.id,
        },
      });
      // CRITICAL: force changes must take effect immediately — drop the cached
      // config or the engine keeps applying the previous force state (D-044).
      await redis.del(keys.configCache(slug));
      return ok(
        {
          slug,
          forceOverride: updated.forceOverride,
          forceRoundsLeft: updated.forceRoundsLeft,
        },
        request.requestId!
      );
    }
  );

  // GET /panel/games/:slug/stats — game analytics
  app.get(
    '/games/:slug/stats',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { slug } = request.params as { slug: string };
      // M-14: settled, real-money rounds only — demo play and open sessions
      // used to inflate rounds/wagered/RTP for the admin's per-game panel.
      const settled = {
        gameSlug: slug,
        demo: false,
        result: { not: 'PENDING' as const },
      };
      const [rounds, wagered, paidOut, wins] = await Promise.all([
        prisma.gameRound.count({ where: settled }),
        prisma.gameRound.aggregate({
          where: settled,
          _sum: { betAmount: true },
        }),
        prisma.gameRound.aggregate({
          where: settled,
          _sum: { payoutAmount: true },
        }),
        prisma.gameRound.count({
          where: { ...settled, result: { in: ['WIN', 'CASHOUT'] } },
        }),
      ]);
      const w = Number(wagered._sum.betAmount || 0);
      return ok(
        {
          totalRounds: rounds,
          totalWagered: w,
          totalPaidOut: Number(paidOut._sum.payoutAmount || 0),
          houseProfit: w - Number(paidOut._sum.payoutAmount || 0),
          winRate: rounds ? (wins / rounds) * 100 : 0,
          effectiveRtp: w ? (Number(paidOut._sum.payoutAmount || 0) / w) * 100 : 0,
        },
        request.requestId!
      );
    }
  );
}
