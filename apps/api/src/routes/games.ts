// apps/api/src/routes/games.ts — lobby, bet (THE core endpoint), cashout, history, feeds
import type { FastifyInstance } from 'fastify';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { betRequestSchema, gameSlugSchema } from '@casino/shared/validators';
import { validateGameChoices } from '@casino/shared/validators/game-choices';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { plinkoBallCount } from '@casino/shared';
import { ok, AppError } from '../lib/core';
import {
  authMiddleware,
  authOrDemoMiddleware,
  rateLimitFactory,
  responsiblePlayGuard,
} from '../middleware';
import { getSetting, getNumericSetting } from '../services/settings';
import { getGameConfig } from '../services/gameConfig';
import { assertStakeWithinLimits, stakeLimitsFor } from '../services/stakeLimits';
import { crashManagers, wingoManagers, wingoBetSchema } from '../socket/SocketServer';
import {
  WINGO_DURATIONS,
  DEFAULT_WINGO_PAYOUTS,
} from '../engine/games/WingoRoundManager';
import { notifyUser } from '../services/notify';
import { pushBigWin, updateWinStreak } from '../services/engagement';
import { OutcomeEngine } from '../engine/OutcomeEngine';
import { sessionManager } from '../engine/session/SessionManager';
import { prisma } from '../db/prisma';
import { redis, logRedisIssue, keys } from '../db/redis';

import { money } from '@casino/shared/utils/money';
import { getWalletSnapshot } from '../services/wallet';
import { maskUsername } from '@casino/game-core/mask';
import { crashMultiplierAt } from '../engine/games/AviatorGame';
import { growthRateFromConfig } from '../engine/games/crash-salvage';

const engine = new OutcomeEngine();

export async function gameRoutes(app: FastifyInstance) {
  // D-092: session games (one bet per round) — declared up top so the bet
  // route can reject the old per-step flow.
  const SESSION_SLUGS = ['mines', 'tower', 'stairs', 'hi-lo'];

  // GET /games — lobby (cached; docs/19 §19 < 100ms)
  app.get('/', async (request) => {
    let cached: string | null = null;
    try {
      cached = await redis.get('cache:lobby');
    } catch (e) {
      logRedisIssue('lobby', e);
    }
    if (cached) return ok(JSON.parse(cached), request.requestId!);
    // D-073: demo is a master switch — games report demoEnabled only when the
    // admin has demo mode ON (default OFF).
    const demoOn = await getSetting<boolean>('demo_mode_enabled');
    const games = await prisma.gameConfig.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        slug: true,
        displayName: true,
        description: true,
        thumbnailUrl: true,
        category: true,
        tags: true,
        demoEnabled: true,
        baseRtp: true,
        minBet: true,
        animationSpeed: true,
      },
    });
    const masked = games.map((g) => ({ ...g, demoEnabled: demoOn && g.demoEnabled }));
    try {
      await redis.set('cache:lobby', JSON.stringify(masked), 'EX', 30);
    } catch {
      /* best effort */
    }
    return ok(masked, request.requestId!);
  });

  // GET /games/lobby-ui — public, non-secret flags the lobby needs.
  // Player clients cannot read /panel/settings. Default is hide names
  // (thumbnails already carry the title).
  app.get('/lobby-ui', async (request) => {
    const show = (await getSetting<boolean>('lobby_show_game_names')) === true;
    return ok({ showGameNames: show }, request.requestId!);
  });

  // GET /games/:slug — detail + rules content (RTP displayed per docs/16 §9)
  app.get('/:slug', async (request) => {
    const { slug } = z.object({ slug: gameSlugSchema }).parse(request.params);
    const game = await prisma.gameConfig.findUnique({ where: { slug } });
    if (!game) throw new AppError(ERROR_CODES.GAME_NOT_FOUND, 404, 'Game not found');
    // v1.4.0: admin-HIDDEN games are fully blocked for players — not just out
    // of the lobby. Every bet entry already 403s via getGameConfig; the detail
    // page must too, otherwise a saved direct link would render a playable
    // shell the user is asked to bet on (and every bet would fail at the end).
    if (!game.isActive)
      throw new AppError(
        ERROR_CODES.GAME_NOT_ACTIVE,
        403,
        'This game is currently unavailable'
      );
    // D-073: same master-switch masking as the lobby list
    const demoOn = await getSetting<boolean>('demo_mode_enabled');
    return ok(
      {
        slug: game.slug,
        displayName: game.displayName,
        description: game.description,
        thumbnailUrl: game.thumbnailUrl,
        category: game.category,
        tags: game.tags,
        demoEnabled: demoOn && game.demoEnabled,
        baseRtp: Number(game.baseRtp),
        // The EFFECTIVE stake window, resolved the same way the bet endpoint
        // enforces it (global floor/ceiling vs the game's own). The client used
        // to render its own guess — the confirm sheet showed a 99,999,999
        // maximum while the server rejected anything over 500,000.
        ...(await (async () => {
          const l = await stakeLimitsFor(slug);
          return { minBet: l.minBet.toNumber(), maxBet: l.maxBet.toNumber() };
        })()),
        maxWinMultiplier: Number(game.maxWinMultiplier),
        animationSpeed: Number(game.animationSpeed),
        // Public game rules/paytables. Hidden outcomes/seeds never live in configJson.
        configJson: game.configJson,
        // D-106/D-107: round duration is a UI fact (not an odds secret) — clients
        // render the "WinGo 30s/1min/3min/5min" header, tabs and filter socket events.
        roundDurationSec: Number(
          (game.configJson as { round_duration_sec?: number })?.round_duration_sec ?? 30
        ),
        roundDurations: Array.isArray(
          (game.configJson as { round_durations?: unknown })?.round_durations
        )
          ? (game.configJson as { round_durations: number[] }).round_durations
          : [30, 60, 180, 300],
      },
      request.requestId!
    );
  });

  // POST /games/:slug/bet — THE core endpoint (docs/19 §7 server steps).
  // Per-account bet rate limit (30/min) plus responsible-play limits and
  // exclusion, which are safety commitments enforced on every real-money bet.
  app.post('/:slug/bet', { preHandler: [authOrDemoMiddleware, rateLimitFactory('bet', (r) => r.user!.id)] }, async (request) => {
    const { slug } = z.object({ slug: gameSlugSchema }).parse(request.params);
    const body = betRequestSchema.parse(request.body);
    const userId = request.user!.id;
    // SECURITY: demo is derived from the AUTHENTICATED ROLE, never from the
    // X-Demo-Mode header alone. The header only lets authOrDemoMiddleware pick
    // the shared demo account; it must not by itself decide whether a bet is
    // real or demo. A real-money user sending the header gets a real bet; a
    // demo account can never settle real money.
    const demo = request.user!.role === 'demo';

    // D-073: demo master switch — when the admin turns demo OFF, demo bets are
    // rejected outright (guests must log in to play).
    if (demo && !(await getSetting<boolean>('demo_mode_enabled'))) {
      throw new AppError(
        ERROR_CODES.GAME_NOT_AVAILABLE,
        403,
        'Demo mode is disabled — log in to play for real money'
      );
    }

    if (!demo) await responsiblePlayGuard(userId);

    // D-092: session games use /:slug/session (one bet per round) — the old
    // per-step /bet flow is disabled so clients can't double-charge themselves.
    if (SESSION_SLUGS.includes(slug)) {
      throw new AppError(
        ERROR_CODES.GAME_NOT_FOUND,
        400,
        `${slug} is a session game — use POST /games/${slug}/session`
      );
    }

    // C-1/C-2: validate `choices` against THIS game's schema before any wallet
    // is touched. It used to be an arbitrary JSON blob passed straight into the
    // maths, which is what let a roulette "split" cover all 37 pockets (1800%
    // RTP) and ten duplicate Keno picks score ten matches off one ball (12502%
    // RTP). Both reproduced against the real handlers.
    const vc = validateGameChoices(slug, body.choices);
    if (!vc.ok) throw new AppError(ERROR_CODES.GAME_INVALID_CHOICES, 400, vc.message);
    const safeChoices = vc.value;

    // H-1: enforce the stake limits. minBet was seeded per game, returned by
    // this very API and rendered in the UI — but never compared to the stake.
    // The only floor was `.positive()`, so R0.01 bets were legal and could be
    // farmed against flat-amount streak/rakeback bonuses.
    await assertStakeWithinLimits(slug, body.amount, demo);

    // Plinko: body.amount is PER BALL. N balls are N independent full stakes,
    // so the wallet debit is amount × balls. A client that only sent `amount`
    // used to drop 16 balls for the price of 1 (the engine averaged the
    // multipliers, so EV matched, but the UI read as "16 drops of this bet").
    const perBall = new Decimal(body.amount);
    let chargedStake = perBall;
    if (slug === 'plinko') {
      const balls = plinkoBallCount(safeChoices);
      chargedStake = perBall.mul(balls).toDecimalPlaces(2);
      if (balls > 1) {
        const { maxBet } = await stakeLimitsFor(slug);
        if (chargedStake.gt(maxBet)) {
          throw new AppError(
            ERROR_CODES.GAME_STAKE_OUT_OF_RANGE,
            400,
            `Maximum bet for this game is ${maxBet.toFixed(2)}. ${balls} balls × ${perBall.toFixed(2)} = ${chargedStake.toFixed(2)}`
          );
        }
      }
    }

    // Aviator/CrashX real-money bets join the SHARED house-clock round (docs/19 §8):
    // wallet debited at placement, cashout via socket timestamp-mutex, settle at crash.
    if ((slug === 'aviator' || slug === 'crash-x') && !demo) {
      const manager = crashManagers[slug];
      if (!manager)
        throw new AppError(
          ERROR_CODES.GAME_NOT_AVAILABLE,
          503,
          'Game is warming up — try again'
        );
      const placed = await manager.placeBet({
        userId,
        amount: body.amount,
        walletType: body.walletType ?? 'AUTO',
        requestId: body.requestId,
      });
      return ok({ ...placed, status: 'PLACED' as const }, request.requestId!);
    }

    // WinGo real-money bets must ALSO join the shared lottery round (v1.3.5·§1).
    // Before this branch, the generic engine fallback below accepted wingo bets,
    // ran a PRIVATE one-player draw, paid instantly, and ignored both the 5s
    // bet lock and the public round — real money against a made-up result that
    // no other player could ever see. Same routing rules as the socket
    // handler: choice + duration validation, shared-round placement, settle at
    // the draw.
    if (slug === 'wingo' && !demo) {
      const parsedW = wingoBetSchema.safeParse({
        amount: body.amount,
        choice: (body.choices as { choice?: unknown } | undefined)?.choice,
        requestId: body.requestId ?? crypto.randomUUID(),
      });
      if (!parsedW.success) {
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          400,
          parsedW.error.issues[0]?.message ?? 'Invalid WinGo bet'
        );
      }
      const dur = Number(
        (body.choices as { durationSec?: unknown } | undefined)?.durationSec ?? 30
      );
      const durKey =
        dur === 60 ? '60s' : dur === 180 ? '180s' : dur === 300 ? '300s' : '30s';
      const manager = wingoManagers[durKey];
      if (!manager)
        throw new AppError(
          ERROR_CODES.GAME_NOT_AVAILABLE,
          503,
          'Game is warming up — try again'
        );
      const placed = await manager.placeBet(
        userId,
        parsedW.data.choice,
        parsedW.data.amount,
        parsedW.data.requestId,
        typeof (body.choices as { roundId?: unknown } | undefined)?.roundId === 'string'
          ? String((body.choices as { roundId?: unknown }).roundId)
          : undefined
      );
      if (!placed.ok) {
        throw new AppError(
          placed.code ?? ERROR_CODES.GAME_NOT_AVAILABLE,
          placed.statusCode ?? 409,
          placed.message ?? 'Bet rejected — wait for the next round'
        );
      }
      return ok(
        {
          status: 'PLACED' as const,
          roundId: placed.roundId,
          durationSec: durKey === '30s' ? 30 : dur,
          newBalance: placed.newBalance,
        },
        request.requestId!
      );
    }

    // Demo bets run against the shared demo user's seed pair (clientSeed 'demo')
    const clientSeed = demo
      ? ((await prisma.seedPair.findFirst({ where: { userId, status: 'ACTIVE' } }))
          ?.clientSeed ?? 'demo')
      : body.clientSeed;

    const result = await engine.processOutcome({
      userId,
      gameSlug: slug,
      betAmount: chargedStake,
      walletType: body.walletType ?? 'AUTO',
      choices: safeChoices,
      clientSeed,
      requestId: body.requestId,
      demo,
    });

    // Win streaks (docs/19 §16) — the WinStreak model + milestone settings
    // existed but nothing ever incremented them, so milestone bonuses were
    // never paid. Fire-and-forget; notifies the player when a bonus lands.
    // C-03: skip replays — resubmitting a settled requestId would otherwise
    // inflate the streak counter and re-pay milestone bonuses.
    if (!demo && !result.replayed) {
      const milestones = await getSetting<Array<{ wins: number; bonus: number }>>(
        'win_streak_milestones'
      );
      void updateWinStreak(
        userId,
        result.result === 'WIN' || result.result === 'CASHOUT',
        milestones ?? [],
        result.roundId // H-10: milestone ledger entries reference the round
      ).then((streak) => {
        if (streak && streak.bonus > 0) {
          void notifyUser(
            userId,
            `${streak.streak}-win streak! 🔥`,
            `You earned a ${process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}${streak.bonus} bonus for ${streak.streak} wins in a row.`,
            'bonus',
            '/bonuses'
          );
        }
      });
    }

    // WebSocket fan-out (v4 spec) — demo rounds never hit the live feed (docs/20 §9)
    const io = (globalThis as { __io?: import('socket.io').Server }).__io;
    if (io && !demo) {
      io.to(`user:${userId}`).emit('balance:update', {
        real: result.newBalance.real,
        bonus: result.newBalance.bonus,
        gifted: result.newBalance.gifted,
        locked: result.newBalance.locked,
      });
      io.to(`game:${slug}`).emit('game:live-bet', {
        userId_masked: await maskedNameFor(userId),
        game: slug,
        betAmount: Number(body.amount),
        result: result.result === 'WIN' || result.result === 'CASHOUT' ? 'win' : 'lose',
        payoutMultiplier: result.payoutMultiplier,
        payoutAmount: result.payoutAmount,
      });
      // D-061: big-win personal notification (threshold from settings) + the
      // lobby big-win ticker feed (feed:lobby:bigwins was read but never written).
      if (
        result.payoutAmount >=
        (await getNumericSetting('big_win_ticker_threshold', 1000))
      ) {
        void notifyUser(
          userId,
          'Big win! 🎉',
          `You won ${process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}${result.payoutAmount.toLocaleString()} on ${slug}`,
          'bigwin',
          `/games/${slug}`
        );
        void pushBigWin({
          userId,
          gameSlug: slug,
          betAmount: Number(body.amount),
          payoutAmount: result.payoutAmount,
          isWin: true,
          demo: false,
        });
      }
    }

    return ok({ ...result, animationData: result.mappedOutcome }, request.requestId!);
  });

  // GET /games/bet-status?clientSeed=&nonce=&game= — timeout recovery (docs/19 §7 4c)
  app.get('/bet-status', { preHandler: [authMiddleware] }, async (request) => {
    const q = request.query as {
      requestId?: string;
      clientSeed?: string;
      nonce?: string;
      game?: string;
    };
    // M-08: the requestId that accompanied the bet is the durable idempotency
    // key — it identifies EXACTLY this wager. The legacy (clientSeed, nonce)
    // probe is kept only for old clients and can return a DIFFERENT tab's
    // round when the nonce was consumed by a concurrent bet.
    const round = await prisma.gameRound.findFirst({
      where: q.requestId
        ? {
            userId: request.user!.id,
            requestId: q.requestId,
            ...(q.game ? { gameSlug: q.game } : {}),
            result: { not: 'PENDING' },
          }
        : {
            userId: request.user!.id,
            clientSeed: q.clientSeed,
            nonce: parseInt(q.nonce || '-1'),
            ...(q.game ? { gameSlug: q.game } : {}),
            // NEVER a PENDING round here. A live session round's mappedOutcome is
            // the raw SessionState — mines, tower traps, the lot. This endpoint
            // returned it verbatim, so anyone could read their own active round's
            // hidden answers by hand. Settled rounds only; in-progress recovery is
            // GET /:slug/session's job (it runs the sanitizer).
            result: { not: 'PENDING' },
          },
      include: { seedPair: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!round) return ok(null, request.requestId!);
    const newBalance = await getWalletSnapshot(request.user!.id);
    return ok(
      {
        round: {
          roundId: round.id,
          result: round.result,
          payoutAmount: Number(round.payoutAmount),
          payoutMultiplier: Number(round.payoutMultiplier),
          mappedOutcome: round.mappedOutcome as Record<string, unknown>,
          nonce: round.nonce,
          seedHash: round.seedPair.serverSeedHash,
          newBalance,
        },
      },
      request.requestId!
    );
  });

  // ── SESSION GAMES (D-092) — mines/tower/stairs/hi-lo ─────────────────────
  // ONE bet per round: POST /:slug/session starts the round (wallet debited
  // once, round row created as PENDING). Steps advance the multiplier. Cashout
  // settles bet × multiplier. GET /:slug/session recovers an in-progress round
  // (timeout safety — never a double charge).

  // POST /games/:slug/session — start a session round
  app.post(
    '/:slug/session',
    { preHandler: [authOrDemoMiddleware, rateLimitFactory('bet', (r) => r.user!.id)] },
    async (request) => {
      const { slug } = z.object({ slug: gameSlugSchema }).parse(request.params);
      if (!SESSION_SLUGS.includes(slug))
        throw new AppError(ERROR_CODES.GAME_NOT_FOUND, 404, 'Game has no session mode');
      const body = betRequestSchema.parse(request.body);
      const userId = request.user!.id;
      // SECURITY: demo comes from the authenticated role, not the header (see /:slug/bet).
      const demo = request.user!.role === 'demo';
      const validatedChoices = validateGameChoices(slug, body.choices);
      if (!validatedChoices.ok) {
        throw new AppError(
          ERROR_CODES.GAME_INVALID_CHOICES,
          400,
          validatedChoices.message
        );
      }
      await assertStakeWithinLimits(slug, body.amount, demo);
      if (demo && !(await getSetting<boolean>('demo_mode_enabled'))) {
        throw new AppError(
          ERROR_CODES.GAME_NOT_AVAILABLE,
          403,
          'Demo mode is disabled — log in to play for real money'
        );
      }
      if (!demo) await responsiblePlayGuard(userId);
      const clientSeed = demo
        ? ((await prisma.seedPair.findFirst({ where: { userId, status: 'ACTIVE' } }))
            ?.clientSeed ?? 'demo')
        : body.clientSeed;
      const created = await sessionManager.create({
        userId,
        slug,
        amount: new Decimal(body.amount),
        walletType: body.walletType ?? 'AUTO',
        clientSeed,
        choices: validatedChoices.value,
        requestId: body.requestId,
        demo,
      });
      return ok({ status: 'SESSION_STARTED', ...created }, request.requestId!);
    }
  );

  // GET /games/:slug/session — recover the active session (timeout recovery)
  app.get('/:slug/session', { preHandler: [authOrDemoMiddleware] }, async (request) => {
    const { slug } = z.object({ slug: gameSlugSchema }).parse(request.params);
    // SECURITY: getActiveView() sanitizes the state (strips mines/traps).
    // NEVER return the raw SessionState here — it contains the answers.
    const active = await sessionManager.getActiveView(request.user!.id, slug);
    return ok(
      active
        ? { status: 'SESSION_ACTIVE', session: active }
        : { status: 'NO_SESSION', session: null },
      request.requestId!
    );
  });

  // POST /games/:slug/step — advance one step (dig / climb / guess)
  app.post('/:slug/step', { preHandler: [authOrDemoMiddleware] }, async (request) => {
    const { slug } = z.object({ slug: gameSlugSchema }).parse(request.params);
    if (!SESSION_SLUGS.includes(slug))
      throw new AppError(ERROR_CODES.GAME_NOT_FOUND, 404, 'Game has no session mode');
    const body = z
      .object({
        roundId: z.string().min(1),
        action: z.record(z.string(), z.unknown()),
      })
      .parse(request.body as unknown);
    const out = await sessionManager.step(
      request.user!.id,
      slug,
      body.roundId,
      body.action
    );
    return ok(out, request.requestId!);
  });

  // GET /games/:slug/history — player's rounds for this game
  app.get('/:slug/history', { preHandler: [authMiddleware] }, async (request) => {
    const { slug } = z.object({ slug: gameSlugSchema }).parse(request.params);
    const q = request.query as { page?: string; pageSize?: string; duration?: string };
    const page = Math.max(1, parseInt(q.page || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize || '20')));
    // v1.3.3 (WinGo parity): the "My history" tab is per lottery time — the
    // board's effect already re-fetches on every duration switch, but the URL
    // carried no duration, so tabs silently mixed 30s/1m/3m/5m rows. When the
    // client passes duration=, keep only that board's rounds.
    const duration = slug === 'wingo' ? Number(q.duration ?? 0) || 0 : 0;
    const userWhere = {
      userId: request.user!.id,
      gameSlug: slug,
      result: { not: 'PENDING' },
      ...(duration
        ? { choices: { path: ['durationSec'], equals: duration } as never }
        : {}),
    } as never;
    const [rows, total] = await Promise.all([
      prisma.gameRound.findMany({
        // D-092: in-progress session rounds are hidden from history — the round
        // appears once it settles (cashout/bust).
        where: userWhere,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          betAmount: true,
          result: true,
          payoutMultiplier: true,
          payoutAmount: true,
          createdAt: true,
          // Settled rounds only (PENDING is filtered out above), so the mapped
          // outcome carries no live secrets — and the WinGo "My history" tab
          // needs it to show the winning ball and the player's target choice.
          mappedOutcome: true,
          // v1.3.3: choices carry {choice, durationSec} for wingo rows — the
          // client shows which board each row came from.
          choices: true,
        },
      }),
      prisma.gameRound.count({
        where: userWhere,
      }),
    ]);
    return ok(
      {
        data: rows,
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

  // GET /games/:slug/live-feed — recent wins all players (masked)
  app.get('/:slug/live-feed', async (request) => {
    const { slug } = z.object({ slug: gameSlugSchema }).parse(request.params);
    let raw: string[] = [];
    try {
      raw = await redis.lrange(`feed:game:${slug}`, 0, 49);
    } catch {
      /* feed empty on redis outage */
    }
    return ok(
      raw.map((r) => JSON.parse(r)),
      request.requestId!
    );
  });

  // GET /games/wingo/recent?duration=30|60|180|300 — last 100 WinGo round
  // results for ONE lottery time (trend grid + stats, D-106/D-107)
  app.get('/wingo/recent', async (request) => {
    const dur = Number((request.query as { duration?: string })?.duration ?? 30);
    const key =
      dur === 60 || dur === 180 || dur === 300
        ? `wingo:history:${dur}`
        : 'wingo:history:30';
    let raw: string[] = [];
    try {
      // v1.3.4: read the TAIL, not the head. pushHistory rpush-appends and
      // ltrim-caps the list at 1000, so lrange(0,99) returned the OLDEST 100
      // draws — the moment a board passed 100 periods (~50 minutes on WinGo
      // 30sec) the trend grid + statistics froze on ancient rounds while the
      // live strip kept moving (reported as "the results chart is wrong").
      raw = await redis.lrange(key, -100, -1);
    } catch {
      /* empty on redis outage */
    }
    return ok(
      raw.map((r) => JSON.parse(r)),
      request.requestId!
    );
  });

  // GET /games/wingo/bet-status?requestId=… — v1.3.5·§2 timeout recovery for
  // shared-round bets. One-shot games already have /games/bet-status
  // (clientSeed+nonce); WinGo bets live in SharedRoundBet keyed by the
  // client-generated requestId. When the bet ack is lost on the wire the
  // client MUST NOT guess — it asks here whether the stake actually landed
  // before deciding to retry or roll back its optimistic balance.
  app.get('/wingo/bet-status', { preHandler: [authMiddleware] }, async (request) => {
    const q = z.object({ requestId: z.string().uuid() }).parse(request.query);
    const bet = await prisma.sharedRoundBet.findFirst({
      where: { gameSlug: 'wingo', userId: request.user!.id, requestId: q.requestId },
      orderBy: { createdAt: 'desc' },
    });
    if (!bet) return ok({ found: false as const }, request.requestId!);
    return ok(
      {
        found: true as const,
        roundId: bet.roundId,
        durationSec: bet.durationSec,
        choice: bet.choice,
        amount: bet.amount.toFixed(2),
        status: bet.status, // PLACED | SETTLING | SETTLED | REFUNDED
        result: bet.result,
        payout: bet.payoutAmount?.toFixed(2) ?? null,
        payoutMultiplier: bet.payoutMultiplier?.toFixed(4) ?? null,
        settledAt: bet.settledAt,
      },
      request.requestId!
    );
  });

  // GET /games/wingo/history-list?duration=&page=&pageSize= — paginated round
  // results for the "Game history" tab (D-108, reference UI: period list rows
  // with the winning digit circled, `< page/total >` pager).
  app.get('/wingo/history-list', async (request) => {
    const dur = Number((request.query as { duration?: string })?.duration ?? 30);
    const q = request.query as { page?: string; pageSize?: string };
    const page = Math.max(1, parseInt(q.page || '1'));
    const pageSize = Math.min(50, Math.max(1, parseInt(q.pageSize || '10')));
    const key =
      dur === 60 || dur === 180 || dur === 300
        ? `wingo:history:${dur}`
        : 'wingo:history:30';
    let raw: string[] = [];
    let total = 0;
    try {
      // v1.3.4: `total` used to be the size of the FETCHED WINDOW — so the
      // pager always reported "page N of N" and the </> paging could walk to
      // infinity. The real total is the list length (capped at 1000 by
      // pushHistory), and each page is an exact window off the tail.
      // Page 1 = newest page (rows still returned newest-first).
      total = await redis.llen(key);
      const from = -(page * pageSize); // e.g. page 2 × size 10 → -20
      const to = -((page - 1) * pageSize + 1); //                     → -11
      if ((page - 1) * pageSize < total) {
        raw = await redis.lrange(key, from, to);
      }
    } catch {
      /* empty */
    }
    const rows = raw
      .slice()
      .reverse()
      .map((r) => JSON.parse(r));
    return ok(
      {
        data: rows,
        total,
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(total / pageSize)),
      },
      request.requestId!
    );
  });

  // GET /games/wingo/rounds — LIVE snapshot of all four lottery times
  // (30s/1min/3min/5min): period, countdown, betting-open, seed hash.
  // v1.3.5·§9: rows now also carry the LIVE payout table + maxWin cap — the
  // client used to render hard-coded multipliers in its how-to/bet UI, so an
  // odds change on the server showed players the old prices until a rebuild.
  app.get('/wingo/rounds', async (request) => {
    const rounds = await Promise.all(
      WINGO_DURATIONS.map((d) => {
        const key = d === 60 ? '60s' : d === 180 ? '180s' : d === 300 ? '300s' : '30s';
        return wingoManagers[key].currentRound();
      })
    );
    const payouts: Record<string, number> = { ...DEFAULT_WINGO_PAYOUTS };
    let maxWinMultiplier: number | null = null;
    try {
      const cfg = await getGameConfig('wingo');
      maxWinMultiplier = Number(cfg.maxWinMultiplier ?? 0) || null;
    } catch {
      /* defaults are the seeded table */
    }
    const rows = rounds.filter(Boolean).map((r) => ({
      ...(r as object),
      payouts,
      maxWinMultiplier,
    }));
    return ok(rows, request.requestId!);
  });

  // GET /games/:slug/crash-state — v1.3.4: join/refresh snapshot for the shared
  // crash games (aviator | crash-x). Reporting flags: before this endpoint the
  // ONLY way a client learned the round state was waiting for the next
  // broadcast cycle, so a player who opened the game (or refreshed) mid-flight
  // saw a parked "Waiting for next round" board while the plane was actually
  // at 6x — AND lost their CASH OUT button entirely (their live bet rode to a
  // guaranteed bust). Returns the current round's public state, the caller's
  // LIVE bet on it (so the UI can restore the cash-out control), and the
  // recent crash points for the history ticker. Public fields only — the
  // crashPoint is a server secret until the round crashes (never leaked here).
  app.get('/:slug/crash-state', async (request) => {
    const { slug } = z
      .object({ slug: z.enum(['aviator', 'crash-x']) })
      .parse(request.params);
    // optional auth — guests still get the public round state
    try {
      await authOrDemoMiddleware(request, {} as never);
    } catch {
      /* guest — myLive stays null */
    }
    const userId = request.user?.id ?? null;

    let round: {
      roundId: string;
      status: 'countdown' | 'flying' | 'crashed';
      multiplier: number;
      crashPoint?: number;
      serverSeedHash?: string;
    } | null = null;
    let myLive: {
      roundId: string;
      amount: string;
      joinMultiplier: number;
      status: string;
    } | null = null;
    let recent: number[] = [];

    try {
      const raw = await redis.get(keys.crashRound(slug));
      if (raw) {
        const s = JSON.parse(raw) as {
          roundId: string;
          status: 'WAITING' | 'BETTING' | 'FLYING' | 'CRASHED';
          startedAt: number | null;
          crashPoint: number;
          serverSeedHash: string;
          config?: unknown;
        };
        const growth = growthRateFromConfig(s.config);
        if (s.status === 'FLYING' && s.startedAt != null) {
          // Same curve as ticks/cashout (taxi 0.10→1.00 then exp). The old
          // e^(g·t) from 1.00 made a mid-taxi refresh show the wrong number.
          const m = crashMultiplierAt(growth, Math.max(0, Date.now() - s.startedAt));
          round = {
            roundId: s.roundId,
            status: 'flying',
            multiplier: Math.min(m, s.crashPoint),
            serverSeedHash: s.serverSeedHash,
          };
        } else if (s.status === 'CRASHED') {
          round = {
            roundId: s.roundId,
            status: 'crashed',
            multiplier: s.crashPoint,
            crashPoint: s.crashPoint, // already revealed to everyone
          };
        } else {
          round = {
            roundId: s.roundId,
            status: 'countdown',
            multiplier: 0.1, // taxi floor — HUD must not flash 1.00x while parked
            serverSeedHash: s.serverSeedHash,
          };
        }

        if (userId && s.status !== 'CRASHED') {
          const bet = await prisma.sharedRoundBet.findFirst({
            where: {
              gameSlug: slug,
              roundId: s.roundId,
              userId,
              status: 'PLACED',
            },
            orderBy: { createdAt: 'desc' },
          });
          if (bet) {
            myLive = {
              roundId: bet.roundId,
              amount: bet.amount.toFixed(2),
              joinMultiplier: Number(bet.joinMultiplier),
              status: s.status === 'FLYING' ? 'flying' : 'countdown',
            };
          }
        }
      }
      const hist = await redis.lrange(`crash:history:${slug}`, -20, -1);
      recent = hist
        .map((h) => {
          try {
            return Number(JSON.parse(h).crashPoint);
          } catch {
            return NaN;
          }
        })
        .filter((n) => Number.isFinite(n))
        .reverse(); // newest first
    } catch {
      /* redis/pg blip — round stays null, client falls back to broadcasts */
    }
    return ok({ slug, round, myLive, recent }, request.requestId!);
  });

  // POST /games/:slug/cashout — server-authoritative cashout (docs/19 §7–8)
  // Aviator/CrashX go through the socket handler (timestamp mutex, docs/20 rule 6).
  // Mines/Tower/Stairs/HiLo (D-092): settles the ACTIVE session at its current
  // multiplier — payout = bet × multiplier, ONE bet per round.
  app.post(
    '/:slug/cashout',
    { preHandler: [authOrDemoMiddleware] },
    async (request) => {
      const { slug } = z.object({ slug: gameSlugSchema }).parse(request.params);
      const SESSION_SLUGS_LOCAL = SESSION_SLUGS;
      if (!SESSION_SLUGS_LOCAL.includes(slug)) {
        throw new AppError(
          ERROR_CODES.GAME_ROUND_NOT_FOUND,
          400,
          `${slug} has no cashout mechanic`
        );
      }
      const body = z
        .object({ roundId: z.string().min(1) })
        .parse(request.body as unknown);
      const out = await sessionManager.cashout(request.user!.id, slug, body.roundId);
      const payout = money(out.view.betAmount)
        .mul(out.view.currentMultiplier)
        .toDecimalPlaces(2);
      return ok(
        {
          roundId: out.view.roundId,
          result: 'CASHOUT',
          multiplier: out.view.currentMultiplier,
          payout: payout.toFixed(2),
          mappedOutcome: out.stepResult,
        },
        request.requestId!
      );
    }
  );
}

/**
 * Masked player label for public feeds.
 * The old local `mask()` masked the raw cuid (e.g. "clx***9f"), which is both
 * meaningless to players and a partial id leak. Use the player's display name
 * via the canonical masker, falling back to a stable pseudonym.
 */
async function maskedNameFor(userId: string): Promise<string> {
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
    return maskUsername(u?.displayName || `Player${userId.slice(-4)}`);
  } catch {
    return maskUsername(`Player${userId.slice(-4)}`);
  }
}
