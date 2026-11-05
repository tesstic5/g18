// apps/api/src/engine/games/CrashRoundManager.ts — Aviator/CrashX house-clock round lifecycle
// (docs/19 §8 + docs/20 rule 6: Redis-timestamp cashout mutex). One instance per process.
//
// Bet flow: POST /games/{slug}/bet with X-Demo-Mode absent routes here (placeBet)
// → wallet deducted AT PLACEMENT → bet joins the shared round → cashout via
// socket `aviator:cashout` (timestamp mutex) → settle() records the round +
// credits the win (never re-deducts).
//
// Auto-cashout was REMOVED by product decision: the player must actively cash
// out. Uncashed bets bust at the crash point.
import crypto from 'crypto';
import Decimal from 'decimal.js';
import {
  RoundResult,
  SharedRoundBet,
  WalletType,
} from '../../../src/generated/prisma/client';
import { redis, keys } from '../../db/redis';
import { prisma } from '../../db/prisma';
import { PROVABLY_FAIR } from '@casino/game-core/provably-fair';
import {
  CrashDistribution,
  generateCrashPoint,
  crashPointV2,
  crashMultiplierAt,
} from './AviatorGame';
import { midFlightPayoutMultiple, warmCurve } from './crash-pricing';
import { DifficultyLevel, crashGateForLevel, resolveDifficulty } from '../difficulty';
import {
  deductBet,
  creditWinProRata,
  primaryWalletType,
  getWalletSnapshot,
} from '../../services/wallet';
import { responsiblePlayTxCheck } from '../../middleware';
import { getGameConfig, snapshotHash } from '../../services/gameConfig';
import { recordRound } from '../StatisticsTracker';
import { AppError } from '../../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { money } from '@casino/shared/utils/money';
import { emitAdmin, shortId } from '../../lib/admin-feed';
import { maskUsername } from '@casino/game-core/mask';
import { recordEngagement } from '../../services/engagement';
import { RoundLeaderLease } from '../RoundLeaderLease';
import { refundOpenSharedBets } from '../../services/sharedRoundBets';
import { maxPayoutFor } from '../../services/stakeLimits';
import { crashSalvageKind } from './crash-salvage';

type RoundStatus = 'WAITING' | 'BETTING' | 'FLYING' | 'CRASHED';

interface RoundBet {
  userId: string;
  amount: string; // decimal string
  walletType: WalletType; // primary funding wallet (largest share)
  /** Wallet split of the stake — the cashout credits these same wallets. */
  deductedFrom: Array<{ type: WalletType; amount: string }>;
  cashedOutAt: number | null;
  cashedOutMultiplier: number | null;
  requestId: string | null; // idempotency (docs/11 rule 3)
  /**
   * The multiplier the plane was showing when this bet joined. 1 for a normal
   * pre-takeoff bet; >1 for a mid-flight entry, which is priced on the odds
   * remaining FROM that point (see crash-pricing.ts).
   */
  joinMultiplier: number;
}

interface RoundState {
  roundId: string;
  slug: string;
  status: RoundStatus;
  serverSeed: string; // secret
  serverSeedHash: string; // committed before bets (docs/20 rule 2)
  crashPoint: number; // secret until crash
  rawPoint: number; // deterministic raw for PF records
  /** Operator level that sized this round's takeoff-blast gate (PF replay input). */
  difficulty: DifficultyLevel;
  config: Record<string, unknown>;
  startedAt: number | null;
  crashedAt: number | null; // server timestamp of crash emission
  bets: RoundBet[];
}

export class CrashRoundManager {
  private io?: import('socket.io').Server;
  private timer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  /** Round currently on the clock — lets failure paths scope their recovery
   *  refunds to THIS round instead of a slug-wide sweep (v1.3.4). */
  private activeRoundId: string | null = null;
  private looping = false;
  /** Resolves the current flight's await — lets pauseLoop unwind a round cleanly. */
  private flightDone: (() => void) | null = null;
  /** Epoch that invalidates loop chains left behind by lease flaps. */
  private generation = 0;
  private readonly lease: RoundLeaderLease;

  constructor(private slug: 'aviator' | 'crash-x') {
    this.lease = new RoundLeaderLease(`leader:round:${slug}`);
  }

  async start(io: import('socket.io').Server) {
    this.io = io;
    this.lease.start(
      () => {
        if (!this.looping) {
          this.looping = true;
          void (async () => {
            // Salvage a committed crash (settle leftovers) or resume an
            // in-flight round. Never slug-wide-refund — that turned known
            // busts/cashouts into stake-back when settlement was still detached.
            await this.salvageInterruptedRound();
            if (this.looping && this.lease.isLeader()) await this.loop();
          })().catch((error) => {
            console.error(
              `[${this.slug}] leader startup failed:`,
              (error as Error).message
            );
            this.pauseLoop();
          });
        }
      },
      () => this.pauseLoop()
    );
  }

  stop() {
    void this.lease.stop(() => this.pauseLoop());
  }

  /**
   * Leader takeover: settle a committed crash, resume an in-flight round, or
   * refund a round that never took off. Never sweeps every PLACED bet for the
   * slug — that refunded live/settling stakes of a round whose crash was known.
   */
  private async salvageInterruptedRound(): Promise<void> {
    const liveKey = keys.crashRound(this.slug);
    const lastKey = `${liveKey}:last`;
    const seen = new Set<string>();
    for (const k of [liveKey, lastKey]) {
      const raw = await redis.get(k).catch(() => null);
      if (!raw) continue;
      let state: RoundState;
      try {
        state = JSON.parse(raw) as RoundState;
      } catch {
        continue;
      }
      if (!state?.roundId || seen.has(state.roundId)) continue;
      seen.add(state.roundId);
      const kind = crashSalvageKind(state);
      if (kind === 'settle') {
        console.warn(
          `[${this.slug}] salvaging crashed round ${state.roundId} (detached settlement leftover)`
        );
        this.activeRoundId = state.roundId;
        await this.settleCrashedBets(state).catch((err) =>
          console.error(`[${this.slug}] salvage settle failed:`, (err as Error).message)
        );
        continue;
      }
      if (kind === 'resume') {
        console.warn(`[${this.slug}] resuming in-flight round ${state.roundId}`);
        this.activeRoundId = state.roundId;
        await this.flyUntilCrash(state).catch((err) =>
          console.error(`[${this.slug}] resume flight failed:`, (err as Error).message)
        );
        continue;
      }
      if (kind === 'refund') {
        await refundOpenSharedBets(this.slug, undefined, state.roundId).catch(
          () => undefined
        );
      }
    }
  }

  private pauseLoop() {
    this.looping = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.timer = null;
    this.tickTimer = null;
    this.flightDone?.();
    this.flightDone = null;
  }

  /** Place a bet on the CURRENT shared round. Wallet is debited here, once. */
  async placeBet(params: {
    userId: string;
    amount: number;
    walletType: WalletType | 'AUTO';
    requestId?: string;
  }): Promise<{
    roundId: string;
    status: 'PLACED';
    joinMultiplier?: number;
    newBalance?: { real: string; bonus: string; gifted: string; locked: string };
  }> {
    const active = await prisma.gameConfig.findUnique({
      where: { slug: this.slug },
      select: { isActive: true },
    });
    if (!active?.isActive)
      throw new AppError(
        ERROR_CODES.GAME_NOT_ACTIVE,
        403,
        'This game is currently unavailable'
      );
    const raw = await redis.get(keys.crashRound(this.slug));
    if (!raw)
      throw new AppError('GAME_006', 409, 'No round available right now — try again');
    const state = JSON.parse(raw) as RoundState;
    if (state.slug !== this.slug)
      throw new AppError('GAME_006', 409, 'Round not available');
    // Mid-flight joining is allowed by product decision: a player must never be
    // locked out of a round. A bet placed while the plane is at 3.5x joins the
    // CURRENT round from 3.5x and is priced on the odds that remain from there
    // (crash-pricing.ts) — otherwise it would be free money, because the house
    // edge lives entirely in the takeoff phase this player just skipped.
    if (state.status === 'CRASHED') {
      throw new AppError(
        'GAME_006',
        409,
        'This round has finished — the next one is seconds away'
      );
    }
    const requestId = params.requestId || crypto.randomUUID();
    const existing = await prisma.sharedRoundBet.findFirst({
      where: {
        userId: params.userId,
        OR: [
          { requestId },
          {
            gameSlug: this.slug,
            roundId: state.roundId,
            status: { in: ['PLACED', 'SETTLING'] },
          },
        ],
      },
    });
    if (existing) {
      return {
        roundId: existing.roundId,
        status: 'PLACED',
        joinMultiplier: Number(existing.joinMultiplier),
        newBalance: await getWalletSnapshot(params.userId),
      };
    }

    let lockHeld = false;
    try {
      lockHeld =
        (await redis.set(keys.betLock(params.userId), '1', 'EX', 10, 'NX')) === 'OK';
    } catch {
      // PostgreSQL wallet lock + unique placement constraints remain authoritative.
      lockHeld = true;
    }
    if (!lockHeld)
      throw new AppError('GAME_007', 409, 'You already have a bet in progress');

    const joinMultiplier =
      state.status === 'FLYING' && state.startedAt
        ? // v2: a join during the taxi window (display 0.10–0.99) joins at the
          // 1.00 line — the pricing curve treats it as a takeoff-equivalent
          // join, inside the same 94–96% band as every other late entry.
          Math.max(
            1,
            crashMultiplierAt(growthRateOf(state), Date.now() - state.startedAt)
          )
        : 1;
    if (joinMultiplier > 1) {
      const dist =
        (state.config as { configJson?: { crash_distribution?: CrashDistribution } })
          ?.configJson?.crash_distribution ?? {};
      try {
        warmCurve(dist);
      } catch {
        /* pricing falls back to 1:1 */
      }
    }

    try {
      const newBalance = await prisma.$transaction(async (tx) => {
        // H-17: serialize the loss-limit decision with stake acceptance.
        await responsiblePlayTxCheck(tx, params.userId, Number(params.amount));
        const deducted = await deductBet(
          params.userId,
          money(params.amount),
          params.walletType,
          requestId,
          tx
        );
        const split = deducted.deductedFrom.map((part) => ({
          type: part.type,
          amount: part.amount.toFixed(2),
        }));
        await tx.sharedRoundBet.create({
          data: {
            userId: params.userId,
            gameSlug: this.slug,
            roundId: state.roundId,
            requestId,
            amount: money(params.amount).toFixed(2),
            walletType: primaryWalletType(deducted.deductedFrom),
            deductedFrom: split as never,
            joinMultiplier: joinMultiplier.toFixed(4),
          },
        });
        return deducted.snapshot;
      });
      // Feed the classic crash-game "All Bets" rail: every placement is
      // broadcast (same masked label the cashout feed uses) so observers see
      // the bet land as a row, and the later {slug}:player-cashout turns it
      // green. Cosmetic only — any speaker failure must never kill a bet.
      try {
        let label = `Player${params.userId.slice(-4)}`;
        const u = await prisma.user.findUnique({
          where: { id: params.userId },
          select: { displayName: true },
        });
        if (u?.displayName) label = u.displayName;
        this.io?.to(`game:${this.slug}`).emit(`${this.slug}:new-bet`, {
          userId_masked: maskUsername(label),
          amount: Number(params.amount),
        });
      } catch {
        /* broadcast is cosmetic */
      }
      return { roundId: state.roundId, status: 'PLACED', joinMultiplier, newBalance };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        return {
          roundId: state.roundId,
          status: 'PLACED',
          joinMultiplier,
          newBalance: await getWalletSnapshot(params.userId),
        };
      }
      throw error;
    } finally {
      try {
        await redis.del(keys.betLock(params.userId));
      } catch {
        /* DB remains authoritative */
      }
    }
  }

  private async loop(generation = this.generation) {
    // D-065: the whole round must be resilient — a transient error (e.g. a DB
    // blip during getGameConfig) must NEVER kill the manager permanently.
    // Previously an unhandled rejection froze the round loop (bets stuck in
    // WAITING forever). Now: catch + log + always schedule the next round.
    try {
      await this.runRound();
    } catch (e) {
      console.error(
        `[${this.slug}] round loop error (continuing):`,
        (e as Error).stack || e
      );
      // The round died BEFORE crashing (e.g. Redis blip at a phase transition).
      // Its durable placements would stay PLACED forever — the next iteration
      // starts a fresh round that settles only its own bets. Refund leftovers
      // (atomic, PLACED-only, idempotent) so stakes can never stick. (roundId-scoped since v1.3.4 so a
      // late recovery never sweeps the NEXT round's live bets).
      await refundOpenSharedBets(
        this.slug,
        undefined,
        this.activeRoundId ?? undefined
      ).catch(() => undefined);
    } finally {
      // Only the CURRENT generation may schedule its successor: if the lease
      // flapped (lost → regained) mid-flight, a stale chain reaching this
      // finally must die here instead of becoming a second concurrent loop.
      if (this.looping && generation === this.generation)
        this.timer = setTimeout(() => void this.loop(generation), 5000);
    }
  }

  private async runRound() {
    // WAITING (round_interval_ms) → BETTING (last 2s) → FLYING → CRASHED → repeat
    // Hidden games must idle — getGameConfig throws GAME_002, and the loop's
    // catch used to refund + retry forever (disable looked like a crash loop).
    try {
      const row = await prisma.gameConfig.findUnique({
        where: { slug: this.slug },
        select: { isActive: true },
      });
      if (!row?.isActive) {
        await redis.del(keys.crashRound(this.slug)).catch(() => undefined);
        return;
      }
    } catch {
      return;
    }
    let config;
    try {
      config = await getGameConfig(this.slug);
    } catch (e) {
      if (e instanceof AppError && e.code === ERROR_CODES.GAME_NOT_ACTIVE) return;
      throw e;
    }
    const cfg = config.configJson as {
      round_interval_ms?: number;
      tick_interval_ms?: number;
      growth_rate?: number;
      crash_distribution?: CrashDistribution;
    };
    const roundInterval = cfg.round_interval_ms ?? 5000;
    const tickInterval = cfg.tick_interval_ms ?? 50;

    // Round start: generate + commit seed BEFORE any bet (docs/20 rule 2).
    // The operator difficulty sizes this round's takeoff-blast gate; it is
    // persisted on the round (config snapshot + PF transcript) so settlement
    // and the public verifier replay the math bit-for-bit.
    const difficulty = await resolveDifficulty(config);
    const gate = crashGateForLevel(difficulty);
    const serverSeed = PROVABLY_FAIR.generateServerSeed();
    const roundId = crypto.randomUUID();
    // v2 (crash-hmac-v2, 2026-08-23): gated rounds crash BELOW 1x — most
    // rounds never leave the pad — and every flight is hard-capped at 12x.
    const rawPoint = generateCrashPoint(serverSeed, roundId, 0.04, gate);
    const crashPoint = crashPointV2(rawPoint, cfg.crash_distribution ?? {});
    const state: RoundState = {
      roundId,
      slug: this.slug,
      status: 'WAITING',
      serverSeed,
      serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
      difficulty,
      crashPoint,
      rawPoint,
      config: { ...config, configJson: config.configJson },
      startedAt: null,
      crashedAt: null,
      bets: [],
    };
    this.activeRoundId = roundId;
    // Build the mid-flight pricing curve NOW, between rounds, so the first
    // mid-flight bet never pays the construction cost inside its wallet
    // transaction (Prisma aborts interactive transactions after 5s).
    try {
      warmCurve(cfg.crash_distribution ?? {});
    } catch {
      /* pricing falls back to 1:1 */
    }
    await redis.set(keys.crashRound(this.slug), JSON.stringify(state));

    this.io?.emit(`${this.slug}:round-start`, {
      roundId,
      countdown: roundInterval / 1000,
      serverSeedHash: state.serverSeedHash,
    });

    // BETTING window = last 2s of waiting (docs/19 §8).
    // Transitions MUST read-modify-write the LIVE Redis state: the in-memory
    // `state` closure goes stale the instant placeBet() pushes a bet into the
    // Redis copy — overwriting it here would silently drop players' bets.
    await sleep(roundInterval - 2000);
    if (!this.looping) return;
    await this.updateLiveState((s) => {
      s.status = 'BETTING';
    });

    await sleep(2000);
    if (!this.looping) return;
    await this.updateLiveState((s) => {
      s.status = 'FLYING';
      s.startedAt = Date.now();
    });

    const raw = await redis.get(keys.crashRound(this.slug));
    const live = raw ? (JSON.parse(raw) as RoundState) : state;
    await this.flyUntilCrash(live, tickInterval);
  }

  /**
   * Ticker until crash. Shared by the happy-path loop and leader-takeover resume
   * so a failover mid-flight does not invent a new round or refund live stakes.
   */
  private async flyUntilCrash(state: RoundState, tickInterval = 50): Promise<void> {
    const growth = growthRateOf(state);
    const mult = (elapsedMs: number) => crashMultiplierAt(growth, elapsedMs);
    let crashed = false;
    const roundId = state.roundId;
    await new Promise<void>((resolve) => {
      this.flightDone = resolve;
      this.tickTimer = setInterval(() => {
        void (async () => {
          try {
            const raw = await redis.get(keys.crashRound(this.slug));
            const live = raw ? (JSON.parse(raw) as RoundState) : null;
            if (!live || live.roundId !== roundId) {
              this.flightDone = null;
              resolve();
              return;
            }
            const elapsed = Date.now() - (live.startedAt ?? Date.now());
            const m = mult(elapsed);
            this.io?.emit(`${this.slug}:tick`, { multiplier: m, elapsed });
            if (m >= live.crashPoint && !crashed) {
              crashed = true;
              clearInterval(this.tickTimer!);
              try {
                await this.crashRound(live, m);
              } catch (ce) {
                console.error(
                  `[${this.slug}] crash commit failed — refunding this round:`,
                  (ce as Error).stack || ce
                );
                await refundOpenSharedBets(this.slug, undefined, live.roundId).catch(
                  () => undefined
                );
              }
              this.flightDone = null;
              resolve();
            }
          } catch (e) {
            console.error(`[${this.slug}] tick loop error:`, (e as Error).stack || e);
            if (crashed) {
              this.flightDone = null;
              resolve();
            }
          }
        })();
      }, tickInterval);
    });
  }

  /** Read-modify-write the LIVE round state in Redis (never clobber new bets). */
  private async updateLiveState(
    mutate: (s: RoundState) => void
  ): Promise<number | null> {
    const raw = await redis.get(keys.crashRound(this.slug));
    if (!raw) return null;
    const live = JSON.parse(raw) as RoundState;
    mutate(live);
    await redis.set(keys.crashRound(this.slug), JSON.stringify(live));
    return live.startedAt;
  }

  /** Cashout — Redis timestamp mutex (docs/20 rule 6): received before crash emission wins. */
  async cashOut(
    userId: string,
    roundId: string,
    receivedAt: number
  ): Promise<{
    success: boolean;
    multiplier?: number;
    planeMultiplier?: number;
    joinMultiplier?: number;
    payout?: string;
  }> {
    const raw = await redis.get(keys.crashRound(this.slug));
    if (!raw) return { success: false };
    const state = JSON.parse(raw) as RoundState;
    if (state.roundId !== roundId || state.status !== 'FLYING')
      return { success: false };
    if (state.crashedAt && receivedAt > state.crashedAt) return { success: false }; // after crash → bust

    try {
      const claimed = await redis.set(
        `aviator:cashout:${roundId}:${userId}`,
        String(receivedAt),
        'EX',
        60,
        'NX'
      );
      if (!claimed) return { success: false };
    } catch {
      // The durable DB claim below remains authoritative during Redis failure.
    }

    // H-08b: the compound unique key was dropped by migration 202608191505 —
    // use findFirst on the individual fields (the PLACED-partial index keeps
    // one active bet per user+round race-free at the DB level).
    const bet = await prisma.sharedRoundBet.findFirst({
      where: { gameSlug: this.slug, roundId, userId },
      orderBy: { createdAt: 'desc' },
    });
    if (!bet || bet.status !== 'PLACED') {
      if (bet?.status === 'SETTLED' && bet.result === 'CASHOUT') {
        return {
          success: true,
          multiplier: Number(bet.payoutMultiplier ?? 0),
          payout: bet.payoutAmount?.toFixed(2) ?? '0.00',
          joinMultiplier: Number(bet.joinMultiplier),
        };
      }
      return { success: false };
    }

    const elapsed = Math.max(0, receivedAt - (state.startedAt ?? receivedAt));
    // v2: below 1.00x this is the partial stake-back cashout (operator
    // decision 2026-08-23 — retention-friendly sting, capped at 12x).
    const rawM = crashMultiplierAt(growthRateOf(state), elapsed);
    const m = Math.min(rawM, state.crashPoint);
    const distribution =
      (state.config as { configJson?: { crash_distribution?: CrashDistribution } })
        ?.configJson?.crash_distribution ?? {};
    const joinAt = Number(bet.joinMultiplier);
    const maxWin = Number(
      (state.config as { maxWinMultiplier?: number })?.maxWinMultiplier ?? 0
    );
    const priced = midFlightPayoutMultiple(joinAt, m, distribution);
    const nominalMultiplier = maxWin > 0 ? Math.min(priced, maxWin) : priced;
    const uncappedPayout = money(bet.amount).mul(nominalMultiplier).toDecimalPlaces(2);
    const payoutCeiling = await maxPayoutFor(this.slug);
    const payout = Decimal.min(uncappedPayout, payoutCeiling).toDecimalPlaces(2);
    const payoutMultiple = payout.div(money(bet.amount)).toDecimalPlaces(4).toNumber();

    // Persist the timestamp and ACTUAL post-cap multiplier before settlement. If
    // this process dies, crashRound/reconciliation honours the cashout exactly.
    const marked = await prisma.sharedRoundBet.updateMany({
      where: { id: bet.id, status: 'PLACED', cashoutRequestedAt: null },
      data: {
        cashoutRequestedAt: new Date(receivedAt),
        cashoutMultiplier: payoutMultiple.toFixed(4),
      },
    });
    if (marked.count !== 1) return { success: false };
    const durableBet = await prisma.sharedRoundBet.findUniqueOrThrow({
      where: { id: bet.id },
    });
    const settled = await this.settle(durableBet, payout, 'CASHOUT', {
      serverSeed: state.serverSeed,
      serverSeedHash: state.serverSeedHash,
      rawPoint: state.rawPoint,
      crashPoint: state.crashPoint,
      difficulty: state.difficulty,
    });
    if (!settled) return { success: false };
    return {
      success: true,
      multiplier: payoutMultiple,
      planeMultiplier: m,
      joinMultiplier: joinAt,
      payout: payout.toFixed(2),
    };
  }

  private async crashRound(state: RoundState, crashedMultiplier: number) {
    // Re-read the freshest state: manual cashouts may have settled bets since
    // this tick began (their cashedOutAt lives in the Redis copy, not `state`).
    // Redis here is a best-effort cache: if it is down AT the crash moment we
    // must still settle from PostgreSQL at the committed crash point —
    // otherwise the whole shared round froze on a transient blip and every
    // open bet sat PLACED until a restart.
    const raw = await redis.get(keys.crashRound(this.slug)).catch(() => null);
    if (raw) state = JSON.parse(raw) as RoundState;
    state.status = 'CRASHED';
    state.crashedAt = Date.now();
    try {
      await redis.set(keys.crashRound(this.slug), JSON.stringify(state));
    } catch {
      /* settle proceeds from PG; loop() restarts the round clock after us */
    }
    // reveal seed at crash (docs/19 §8 phase 4)
    this.io?.emit(`${this.slug}:crash`, {
      crashPoint: state.crashPoint,
      roundId: state.roundId,
      serverSeed: state.serverSeed,
    });
    // Crash history for join snapshots (the client history ticker fires up
    // pre-filled instead of empty until the first LIVE crash lands). Mirrors
    // wingo's pushHistory: one bounded Redis list per game, no migration.
    try {
      await redis.rpush(
        `crash:history:${this.slug}`,
        JSON.stringify({ crashPoint: state.crashPoint, at: Date.now() })
      );
      await redis.ltrim(`crash:history:${this.slug}`, -50, -1);
    } catch {
      /* cosmetic */
    }
    // Durable enough for a leader takeover after the live key rotates.
    try {
      await redis.set(
        `${keys.crashRound(this.slug)}:last`,
        JSON.stringify(state),
        'EX',
        120
      );
    } catch {
      /* salvage best-effort */
    }
    // v1.3.4: settlement runs DETACHED — the shared clock must not wait on
    // hundreds of serial wallet commits (the "endless dead air after every
    // crash" symptom). round-clear is emitted when settlements finish.
    void this.settleCrashedBets(state).catch(async (error) => {
      console.error(
        `[${this.slug}] detached settlement failed — refunding THIS round:`,
        (error as Error).stack || error
      );
      await refundOpenSharedBets(this.slug, undefined, state.roundId).catch(
        () => undefined
      );
      this.io?.emit(`${this.slug}:round-clear`, {});
    });
    void crashedMultiplier;
    // NOTE: next round is scheduled by loop()'s finally — never schedule here
    // (double-scheduling would start two concurrent round loops; D-065).
  }

  /** Settle every durable placement of a crashed round. A cashout request
   *  persisted just before a process failure is honoured; all others bust. */
  private async settleCrashedBets(state: RoundState): Promise<void> {
    const bets = await prisma.sharedRoundBet.findMany({
      where: { gameSlug: this.slug, roundId: state.roundId, status: 'PLACED' },
      orderBy: { createdAt: 'asc' },
    });
    for (const bet of bets) {
      try {
        const cashoutMult = bet.cashoutMultiplier
          ? Number(bet.cashoutMultiplier)
          : null;
        const result: 'CASHOUT' | 'BUST' =
          bet.cashoutRequestedAt && cashoutMult ? 'CASHOUT' : 'BUST';
        const payout =
          result === 'CASHOUT'
            ? money(bet.amount).mul(cashoutMult!).toDecimalPlaces(2)
            : money(0);
        await this.settle(bet, payout, result, {
          serverSeed: state.serverSeed,
          serverSeedHash: state.serverSeedHash,
          rawPoint: state.rawPoint,
          crashPoint: state.crashPoint,
          difficulty: state.difficulty,
        });
      } catch (error) {
        console.error(
          `[${this.slug}] settle failed for ${bet.userId}:`,
          (error as Error).message
        );
      }
    }
    this.io?.emit(`${this.slug}:round-clear`, {});
  }

  /** Settle one durable placement exactly once. */
  private async settle(
    bet: SharedRoundBet,
    payout: ReturnType<typeof money>,
    result: 'CASHOUT' | 'BUST',
    pf: {
      serverSeed: string;
      serverSeedHash: string;
      rawPoint: number;
      crashPoint: number;
      /** Operator level that sized this round's takeoff gate (PF replay input). */
      difficulty: DifficultyLevel;
    }
  ): Promise<boolean> {
    const config = await getGameConfig(this.slug).catch(() => null);
    const settled = await prisma.$transaction(async (tx) => {
      const claim = await tx.sharedRoundBet.updateMany({
        where: { id: bet.id, status: 'PLACED' },
        data: { status: 'SETTLING' },
      });
      if (claim.count !== 1) return false;

      // GameRound keeps a relation to the user's active seed for ownership/history,
      // but verification uses the explicit house-clock transcript in mappedOutcome.pf.
      const seedPair = await tx.seedPair.findFirstOrThrow({
        where: { userId: bet.userId, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
      });
      const multiplier = money(bet.amount).eq(0)
        ? 0
        : payout.div(money(bet.amount)).toNumber();
      const round = await tx.gameRound.create({
        data: {
          userId: bet.userId,
          gameSlug: this.slug,
          betAmount: bet.amount.toFixed(2),
          walletTypeUsed: bet.walletType,
          requestId: bet.requestId,
          choices: {},
          seedPairId: seedPair.id,
          clientSeed: `crash:${bet.roundId}`,
          nonce: 0,
          rawOutcome: new Decimal(pf.rawPoint).toFixed(16),
          mappedOutcome: {
            roundId: bet.roundId,
            crashPoint: pf.crashPoint,
            result,
            joinMultiplier: Number(bet.joinMultiplier),
            multiplier,
            payout: payout.toNumber(),
            pf: {
              // New lanes store v2; legacy rounds verify under crash-hmac-v1.
              algorithm: 'crash-hmac-v2',
              roundId: bet.roundId,
              serverSeed: pf.serverSeed,
              serverSeedHash: pf.serverSeedHash,
              rawPoint: pf.rawPoint,
              difficulty: pf.difficulty,
            },
          } as never,
          result: result as RoundResult,
          payoutMultiplier: multiplier.toFixed(4),
          payoutAmount: payout.toFixed(2),
          configSnapshot: {
            ...(config ?? {}),
            // The difficulty that sized this round's takeoff-blast gate — the
            // verifier can only replay the crash math if the same level is
            // reproducible from the stored snapshot.
            difficulty: pf.difficulty,
          } as never,
          configSnapshotHash: config ? snapshotHash(config) : '',
          forceUsed: 'NONE',
        },
      });
      if (payout.gt(0)) {
        const split = (
          bet.deductedFrom as unknown as Array<{ type: WalletType; amount: string }>
        ).map((part) => ({ type: part.type, amount: money(part.amount) }));
        await creditWinProRata(bet.userId, split, payout, round.id, tx);
      }
      await tx.sharedRoundBet.update({
        where: { id: bet.id },
        data: {
          status: 'SETTLED',
          result,
          payoutMultiplier: multiplier.toFixed(4),
          payoutAmount: payout.toFixed(2),
          settledAt: new Date(),
        },
      });
      return true;
    });
    if (!settled) return false;

    await recordRound(
      this.slug,
      Number(bet.amount),
      payout.toNumber(),
      result === 'CASHOUT'
    );
    void recordEngagement({
      userId: bet.userId,
      gameSlug: this.slug,
      betAmount: Number(bet.amount),
      payoutAmount: payout.toNumber(),
      isWin: result === 'CASHOUT',
      demo: false,
    });
    emitAdmin('live-bet', {
      kind: 'bet',
      at: Date.now(),
      userId: shortId(bet.userId),
      game: this.slug,
      betAmount: Number(bet.amount),
      result,
      payoutAmount: payout.toNumber(),
    });
    this.io?.to(`user:${bet.userId}`).emit(`${this.slug}:my-result`, {
      result,
      multiplier:
        result === 'BUST' ? pf.crashPoint : payout.div(money(bet.amount)).toNumber(),
      payout: payout.toNumber(),
      joinMultiplier: Number(bet.joinMultiplier),
    });
    const snapshot = await getWalletSnapshot(bet.userId);
    this.io?.to(`user:${bet.userId}`).emit('balance:update', snapshot);
    return true;
  }
}

/**
 * The flight-speed constant for a round. MUST match the ticker, or a cashout
 * would be priced on a different curve than the one the player watched.
 */
function growthRateOf(state: { config?: unknown }): number {
  const cfg = (state.config as { configJson?: { growth_rate?: number } } | undefined)
    ?.configJson;
  return Number(cfg?.growth_rate ?? 0.00016);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
