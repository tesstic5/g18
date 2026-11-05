// apps/api/src/engine/OutcomeEngine.ts — THE CORE (canonical v3 + docs/06 hardening).
// Raw = HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`) first 8 hex chars ÷ 2³².
// Settlement is ONE transaction: debit → round row (+configSnapshotHash) → nonce++
// → force decrement → credit win. Idempotency via requestId; Redis bet lock per user.
import crypto from 'crypto';
import {
  ForceOverride,
  GameConfig,
  Prisma,
  RoundResult,
  WalletType,
} from '../generated/prisma/client';
import Decimal from 'decimal.js';
import { prisma } from '../db/prisma';
import { rotateSeedIfDue } from '../services/seeds';
import { responsiblePlayTxCheck } from '../middleware';
import { redis, keys } from '../db/redis';
import { AppError } from '../lib/core';
import { getGameConfig, snapshotHash, validateConfig } from '../services/gameConfig';
import { maxPayoutFor } from '../services/stakeLimits';
import {
  deductBet,
  creditWinProRata,
  primaryWalletType,
  getWalletSnapshot,
} from '../services/wallet';
import { recordRound } from './StatisticsTracker';
import {
  getGameHandler,
  ensureGamesRegistered,
  GameHandlerResult,
  BaseGame,
} from './games/BaseGame';
import { emitAdmin, shortId } from '../lib/admin-feed';
import { recordEngagement } from '../services/engagement';
import {
  resolveDifficulty,
  effectiveWinChance,
  type DifficultyLevel,
} from './difficulty';

export interface BetRequest {
  userId: string;
  gameSlug: string;
  betAmount: Decimal;
  walletType: WalletType | 'AUTO';
  choices: Record<string, unknown>;
  clientSeed: string;
  requestId?: string;
  /** Demo mode (docs/20 §9): no wallet movement, rounds flagged demo:true, no stats. */
  demo?: boolean;
}

export interface OutcomeResult {
  roundId: string;
  result: RoundResult;
  /** C-03: true when this reply is the idempotent replay of an already-settled
   * round (duplicate requestId). Replays must never re-fire side effects such
   * as win-streak / milestone bonuses or live-feed fan-out. */
  replayed: boolean;
  rawOutcome: number;
  mappedOutcome: unknown;
  payoutMultiplier: number;
  payoutAmount: number;
  newBalance: { real: string; bonus: string; gifted: string; locked: string };
  seedHash: string;
  nonce: number;
}

export class OutcomeEngine {
  /** Provably fair raw number — ÷ 2³² (v3 canonical, supersedes 0xFFFFFFFF). */
  generateRawOutcome(serverSeed: string, clientSeed: string, nonce: number): number {
    const hmac = crypto.createHmac('sha256', serverSeed);
    hmac.update(`${clientSeed}:${nonce}`);
    const hash = hmac.digest('hex');
    return parseInt(hash.substring(0, 8), 16) / 0x100000000;
  }

  // NOTE: the legacy RTP/win-rate steering curve (computeAdjustedWinThreshold)
  // and weighted payout selection (selectPayoutFromWeights) were REMOVED.
  // They were never called from processOutcome (live decision is
  // fairWinChance × difficulty, see decideWin), and keeping dead steering code
  // around invites accidental re-wiring into settlement. winRateSteering
  // .isSteerable() remains as a fail-closed stub.

  /** Pure committed-draw mapping used by settlement and property tests. */
  async resolveCommittedOutcome(input: {
    gameSlug: string;
    rawOutcome: number;
    config: GameConfig;
    choices: Record<string, unknown>;
    forceMode?: ForceOverride;
    /** Difficulty in force for this bet (rounds store it in the config snapshot). */
    difficulty?: DifficultyLevel;
  }): Promise<GameHandlerResult> {
    await ensureGamesRegistered();
    const handler = getGameHandler(input.gameSlug);
    const forceMode = input.forceMode ?? 'NONE';
    const decision = await this.decideWin({
      handler,
      config: input.config,
      choices: input.choices,
      rawOutcome: input.rawOutcome,
      forceMode,
      difficulty: input.difficulty ?? 'normal',
    });
    return handler.resolve({
      isWin: decision,
      rawOutcome: input.rawOutcome,
      config: input.config,
      choices: input.choices,
      forceMode,
      difficulty: input.difficulty ?? 'normal',
    });
  }

  /**
   * Win/lose decision for one committed draw. For games with an exact fair win
   * chance (all one-shot games) the decision respects the operator's
   * difficulty: the SAME draw u wins iff u < fairChance x difficultyFactor —
   * at 'normal' that is precisely the game's fair event, so nothing about the
   * committed chain changes unless the operator turned a knob. Legacy/global
   * games without a modelled chance keep the historical winRate comparison.
   */
  private async decideWin(input: {
    handler: BaseGame;
    config: GameConfig;
    choices: Record<string, unknown>;
    rawOutcome: number;
    forceMode: ForceOverride;
    difficulty: DifficultyLevel;
  }): Promise<boolean> {
    if (input.forceMode === 'FORCE_WIN') return true;
    if (input.forceMode === 'FORCE_LOSE') return false;
    const pFair = input.handler.fairWinChance(input.choices, input.config);
    if (pFair === null) return input.rawOutcome < Number(input.config.winRate) / 100; // legacy games
    return input.rawOutcome < effectiveWinChance(pFair, input.difficulty);
  }

  async processOutcome(request: BetRequest): Promise<OutcomeResult> {
    // Redis bet lock — one active bet per USER (docs/11 #38).
    //
    // Deliberately NOT scoped per game. A user has ONE active SeedPair, shared
    // by every game, and a round's outcome is HMAC(clientSeed, nonce). Two
    // concurrent bets — even on different games — would read the same nonce
    // and derive both rounds from a single verifiable draw, so they must be
    // serialised. This lock is the cheap fail-fast; the conditional nonce
    // claim inside the settlement transaction is the authoritative guard.
    //
    // D-081: FAIL-OPEN — if Redis is down we skip the lock rather than block
    // every bet (the DB transaction is the real correctness guard).
    const lockKey = keys.betLock(request.userId);
    let locked: boolean;
    try {
      locked = (await redis.set(lockKey, '1', 'EX', 10, 'NX')) === 'OK';
    } catch (e) {
      console.error('[bet] redis lock unavailable — proceeding:', (e as Error).message);
      locked = true;
    }
    if (!locked)
      throw new AppError('GAME_007', 409, 'You already have a bet in progress');
    try {
      return await this.processOutcomeLocked(request);
    } finally {
      try {
        await redis.del(lockKey);
      } catch {
        /* best effort */
      }
    }
  }

  private async processOutcomeLocked(request: BetRequest): Promise<OutcomeResult> {
    const demo = request.demo === true;
    // Idempotency (docs/11 rule 3): duplicate requestId returns the stored round
    if (request.requestId) {
      const existing = await prisma.gameRound.findUnique({
        where: {
          userId_requestId: { userId: request.userId, requestId: request.requestId },
        },
        include: { seedPair: true },
      });
      if (existing) {
        const snapshot = await getWalletSnapshot(request.userId);
        return this.toResult(existing, snapshot, true);
      }
    }

    const config = await getGameConfig(request.gameSlug); // crash-hardened
    const seedPair = await prisma.seedPair.findFirstOrThrow({
      where: { userId: request.userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    if (request.clientSeed && request.clientSeed !== seedPair.clientSeed) {
      throw new AppError('SEED_MISMATCH', 400, 'Client seed mismatch — refresh seed');
    }

    const rawOutcome = this.generateRawOutcome(
      seedPair.serverSeed,
      seedPair.clientSeed,
      seedPair.nonce
    );

    // Force override — CLAIM the round up front, do not just read the config.
    //
    // The game config is cached for 60s, so `forceRoundsLeft` here is a stale
    // snapshot. The decision below was made from that snapshot while the actual
    // decrement happened later in the settlement transaction, so an admin who
    // set "FORCE_WIN for 5 rounds" got more than five: measured, a 5-round
    // budget produced 7 consecutive forced wins because rounds 6 and 7 still
    // saw a cached count above zero.
    //
    // A conditional updateMany is the claim: only a row that still has budget
    // can be decremented, and only the request that wins that update is allowed
    // to force its outcome. Everyone else falls through to the normal odds.
    let forceMode: ForceOverride = 'NONE';
    // Force overrides are an operator production feature (admin panel), but
    // they only apply to one-shot games — session games own their rounds
    // (mines/tower/stairs/hi-lo) and shared rounds (crash/wingo) cannot be
    // steered per-player. The eligibility probe is the handler's fairWinChance.
    await ensureGamesRegistered();
    const handlerProbe = getGameHandler(request.gameSlug);
    const forceEligible =
      !demo && handlerProbe.fairWinChance(request.choices, config) !== null;
    // C-05: outcome overrides only execute when the operator EXPLICITLY signed
    // them in via ALLOW_OUTCOME_OVERRIDES=true, and never in production — a
    // panel bug or leaked credential must never be able to steer real wagers.
    const overridesAllowed =
      process.env.ALLOW_OUTCOME_OVERRIDES === 'true' &&
      process.env.NODE_ENV !== 'production';
    if (
      config.forceOverride !== 'NONE' &&
      Number(config.forceRoundsLeft) > 0 &&
      !overridesAllowed
    ) {
      console.warn(
        `[security] forceOverride=${config.forceOverride} on "${request.gameSlug}" ignored ` +
          `(ALLOW_OUTCOME_OVERRIDES !== true in ${process.env.NODE_ENV ?? 'development'})`
      );
    }
    if (forceEligible && overridesAllowed && config.forceOverride !== 'NONE') {
      const claimed = await prisma.gameConfig.updateMany({
        where: {
          slug: request.gameSlug,
          forceOverride: config.forceOverride,
          forceRoundsLeft: { gt: 0 },
        },
        data: { forceRoundsLeft: { decrement: 1 } },
      });
      if (claimed.count === 1) {
        forceMode = config.forceOverride;
        // The count just changed, so the cached copy is wrong for the next bet.
        await redis.del(`cache:game_config:${request.gameSlug}`).catch(() => {});
      }
    }

    // M-04: the claim above is a compensatable PRE-authorisation, not a burn.
    // If anything between here and the settled commit fails (choice validation,
    // handler rejection, a dead settlement tx), the round goes BACK into the
    // budget — a consumed force round must always correspond to an audited,
    // committed GameRound.
    let forceClaimPending = forceMode !== 'NONE';
    const refundForceClaim = async (): Promise<void> => {
      if (!forceClaimPending) return;
      forceClaimPending = false;
      // Mirrors the claim predicate (same slug AND same override mode). If the
      // operator has since changed or cleared the override, the counter is
      // theirs now and must not be credited back into the new budget.
      //
      // Direction of failure, stated plainly: if this write is LOST, the
      // decrement stands and a forced round is consumed with no audited
      // GameRound to show for it — the budget silently leaks, which is the bad
      // direction. Hence the error log: ops must be able to reconcile it.
      try {
        const restored = await prisma.gameConfig.updateMany({
          where: {
            slug: request.gameSlug,
            forceOverride: config.forceOverride,
          },
          data: { forceRoundsLeft: { increment: 1 } },
        });
        if (restored.count !== 1) {
          console.error(
            `[force-override] refund lost for "${request.gameSlug}" ` +
              `(forceOverride=${config.forceOverride}, rows=${restored.count}) — ` +
              'one forced round was consumed without a committed round.'
          );
        }
      } catch (e) {
        console.error(
          `[force-override] refund failed for "${request.gameSlug}" ` +
            `(forceOverride=${config.forceOverride}):`,
          (e as Error).message
        );
      }
    };

    // Operator difficulty (per-game override else platform default). Only
    // consulted for games with a modelled fair chance; harmless otherwise.
    const difficulty: DifficultyLevel = await resolveDifficulty(config);

    // A committed seed draw is used exactly once. No candidate searching.
    const resolved = await this.resolveCommittedOutcome({
      gameSlug: request.gameSlug,
      rawOutcome,
      config,
      choices: request.choices,
      forceMode,
      difficulty,
    }).catch(async (error: unknown) => {
      // M-04: resolve-time rejection (invalid choices, handler refusal) must
      // not eat the claimed force round.
      await refundForceClaim();
      throw error;
    });

    const nominalMultiplier = Math.max(
      0,
      Math.min(resolved.payoutMultiplier, Number(config.maxWinMultiplier))
    );
    const payoutAmount = request.betAmount.mul(nominalMultiplier).toDecimalPlaces(2);
    const forceCapped =
      config.forceMaxPayout && forceMode === 'FORCE_WIN'
        ? Decimal.min(
            payoutAmount,
            new Decimal(config.forceMaxPayout.toString())
          ).toDecimalPlaces(2)
        : payoutAmount;

    // LIABILITY CAP. The amount actually paid is the source of truth for the
    // stored multiplier, verdict, mapped outcome, history, and client response.
    // Previously those fields kept the larger pre-cap multiplier, so a cap could
    // pay less than the stake while the UI and ledger row still said WIN at X×.
    const payoutCeiling = await maxPayoutFor(request.gameSlug).catch(() => null);
    const finalPayout = payoutCeiling
      ? Decimal.min(forceCapped, payoutCeiling).toDecimalPlaces(2)
      : forceCapped;
    const effectiveMultiplier = finalPayout
      .div(request.betAmount)
      .toDecimalPlaces(4)
      .toNumber();
    const profitable = finalPayout.gt(request.betAmount);
    const returnedSomething = finalPayout.gt(0);
    resolved.result =
      resolved.result === 'BUST'
        ? 'BUST'
        : finalPayout.eq(request.betAmount)
          ? 'PUSH'
          : profitable
            ? resolved.result === 'CASHOUT'
              ? 'CASHOUT'
              : 'WIN'
            : 'LOSE';
    resolved.payoutMultiplier = effectiveMultiplier;

    const mapped =
      resolved.mappedOutcome && typeof resolved.mappedOutcome === 'object'
        ? { ...(resolved.mappedOutcome as Record<string, unknown>) }
        : {};
    mapped.multiplier = effectiveMultiplier;
    if (typeof mapped.aggregate === 'number') mapped.aggregate = effectiveMultiplier;
    if (typeof mapped.currentMultiplier === 'number')
      mapped.currentMultiplier = effectiveMultiplier;
    mapped.payout = finalPayout.toNumber();
    mapped.win = profitable;
    mapped.push = resolved.result === 'PUSH';
    mapped.partialRefund =
      returnedSomething && !profitable && resolved.result !== 'PUSH';
    if (effectiveMultiplier !== nominalMultiplier)
      mapped.nominalMultiplier = nominalMultiplier;
    resolved.mappedOutcome = mapped;

    // ── SETTLEMENT — single transaction (docs/06 #9, docs/20 rules 2/5) ──
    let forceConsumed = forceMode !== 'NONE';
    // H-18: mint the round id BEFORE the wallet debit so the BET ledger entry
    // and the WIN entry both reference the FINAL GameRound — end-to-end
    // reconciliation stake ↔ settlement needs no requestId guessing.
    //
    // Scope: that holds for ONE-SHOT games, where debit and settlement happen
    // in the same transaction. Shared-round games (WinGo, crash/aviator) are
    // the exception — the stake is debited when the bet is PLACED, long before
    // this round id exists, so their BET ledger row carries the CLIENT
    // requestId (WingoRoundManager/CrashRoundManager placeBet) while the WIN
    // row carries the round id. Reconciling stake ↔ settlement for those
    // games joins through SharedRoundBet, not through referenceId.
    const roundId = crypto.randomUUID();
    const settled = await prisma
      .$transaction(async (tx) => {
        // Demo mode: no wallet movement (docs/20 §9) — snapshot stays untouched
        let snapshot = { real: '0', bonus: '0', gifted: '0', locked: '0' };
        // H-17增益: the loss-limit decision must be serialized WITH stake
        // acceptance, or two concurrent bets each pass the pre-check and exceed
        // the cap together. This re-checks inclusively of open exposure and the
        // CURRENT stake, with the user row locked FOR UPDATE.
        if (!demo)
          await responsiblePlayTxCheck(tx, request.userId, Number(request.betAmount));
        // Track WHICH wallets funded the stake so the win is credited back to the
        // same ones (prevents bonus/gifted funds becoming withdrawable cash).
        let deductedFrom: Array<{ type: WalletType; amount: Decimal }> = [];
        if (!demo) {
          ({ snapshot, deductedFrom } = await deductBet(
            request.userId,
            request.betAmount,
            request.walletType,
            // ledger reference = the round row itself (H-18); requestId remains
            // the idempotency key.
            roundId,
            tx
          ));
        }

        // The allotment was already CLAIMED above, before the outcome was decided
        // — claiming it here as well consumed two rounds per forced bet. If
        // forceMode is set at this point, this round is a legitimately claimed
        // forced round.
        forceConsumed = forceMode !== 'NONE';

        const round = await tx.gameRound.create({
          data: {
            id: roundId,
            userId: request.userId,
            gameSlug: request.gameSlug,
            betAmount: request.betAmount.toFixed(2),
            // The wallet that funded the largest share of the stake (was hardcoded
            // 'REAL', which misreported every bonus/gifted-funded round).
            walletTypeUsed: demo ? 'REAL' : primaryWalletType(deductedFrom),
            requestId: request.requestId || undefined,
            choices: request.choices as Prisma.InputJsonValue,
            seedPairId: seedPair.id,
            clientSeed: seedPair.clientSeed,
            nonce: seedPair.nonce,
            rawOutcome: new Decimal(rawOutcome).toFixed(16),
            mappedOutcome: resolved.mappedOutcome as Prisma.InputJsonValue,
            result: resolved.result,
            payoutMultiplier: new Decimal(effectiveMultiplier).toFixed(4),
            payoutAmount: finalPayout.toFixed(2),
            configSnapshot: {
              ...config,
              configJson: config.configJson,
              // The difficulty that decided this round — later rounds can only be
              // verified if the same decision inputs are reproducible.
              difficulty,
            } as Prisma.InputJsonValue,
            configSnapshotHash: snapshotHash(config),
            forceUsed: demo || !forceConsumed ? 'NONE' : forceMode,
            demo,
          },
          include: { seedPair: true },
        });

        // nonce increment (atomic — docs/20 rule 3). The force decrement already
        // happened above, before the round row was written.
        // H-01: nonce CLAIM inside this transaction, conditioned on the value we
        // derived the outcome from. If another concurrent bet already consumed
        // this nonce, rollback — never settle two rounds from one draw, even if
        // every outer lock (Redis) failed open.
        const claimed = await tx.seedPair.updateMany({
          where: { id: seedPair.id, nonce: seedPair.nonce },
          data: { nonce: { increment: 1 } },
        });
        if (claimed.count !== 1)
          throw new AppError(
            'GAME_007',
            409,
            'Concurrent bet in progress — please retry'
          );

        // win credit (skipped in demo — no money moves, docs/20 §9)
        let newBalance = snapshot;
        if (!demo && finalPayout.gt(0)) {
          newBalance = await creditWinProRata(
            request.userId,
            deductedFrom,
            finalPayout,
            round.id,
            tx
          );
        }
        return { round, newBalance };
      })
      .catch(async (error: unknown) => {
        // M-04: settlement rolled back ⇒ no audited round exists; restore the
        // claimed force round so the ledger and the budget stay reconcilable.
        await refundForceClaim();
        throw error;
      });

    const roundWon = resolved.result === 'WIN' || resolved.result === 'CASHOUT';

    // Rolling window (outside tx — docs/20 §10) — demo rounds never counted
    if (!demo) {
      await recordRound(
        request.gameSlug,
        Number(request.betAmount),
        Number(finalPayout),
        roundWon
      );
      // Engagement side-effects: leaderboards, live feed, daily-loss tracking,
      // lastActivityAt. Fire-and-forget — never block or fail a settled bet.
      void recordEngagement({
        userId: request.userId,
        gameSlug: request.gameSlug,
        betAmount: Number(request.betAmount),
        payoutAmount: Number(finalPayout),
        isWin: roundWon,
        demo: false,
      });
    }

    // Admin live feed (outside tx) — never for demo rounds
    if (!demo) {
      emitAdmin('live-bet', {
        kind: 'bet',
        at: Date.now(),
        userId: shortId(request.userId),
        game: request.gameSlug,
        betAmount: Number(request.betAmount),
        result: resolved.result,
        payoutAmount: Number(finalPayout),
      });
    }

    if (!demo) rotateSeedIfDue(request.userId, seedPair.nonce + 1);
    return this.toResult(settled.round, settled.newBalance, false);
  }

  private toResult(
    round: {
      id: string;
      result: RoundResult;
      rawOutcome: unknown;
      mappedOutcome: unknown;
      payoutMultiplier: unknown;
      payoutAmount: unknown;
      nonce: number;
      seedPair: { serverSeedHash: string };
    },
    newBalance?: { real: string; bonus: string; gifted: string; locked: string },
    replayed = false
  ): OutcomeResult {
    return {
      roundId: round.id,
      result: round.result,
      replayed,
      rawOutcome: Number(round.rawOutcome),
      mappedOutcome: round.mappedOutcome,
      payoutMultiplier: Number(round.payoutMultiplier),
      payoutAmount: Number(round.payoutAmount),
      newBalance: newBalance ?? { real: '0', bonus: '0', gifted: '0', locked: '0' },
      seedHash: round.seedPair.serverSeedHash,
      nonce: round.nonce,
    };
  }

  static validateConfig = validateConfig; // docs/06 — RTP ceiling in-request
}
