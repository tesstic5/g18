// apps/api/src/engine/session/SessionManager.ts — session lifecycle for multi-step
// games (D-092). DB GameRound(result PENDING) is the source of truth; the session
// state (multiplier, steps, hidden grid) lives in mappedOutcome. Wallet is debited
// ONCE at creation; steps are free; cashout/bust settle the single bet.
import Decimal from 'decimal.js';
import crypto from 'crypto';
import { prisma } from '../../db/prisma';
import { AppError } from '../../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { getGameConfig, snapshotHash } from '../../services/gameConfig';
import { maxPayoutFor } from '../../services/stakeLimits';
import { rotateSeedIfDue } from '../../services/seeds';
import { responsiblePlayTxCheck } from '../../middleware';
import {
  deductBet,
  creditWinProRata,
  primaryWalletType,
  getWalletSnapshot,
} from '../../services/wallet';
import { recordRound } from '../StatisticsTracker';
import { emitAdmin, shortId } from '../../lib/admin-feed';
import { recordEngagement } from '../../services/engagement';
import { money } from '@casino/shared/utils/money';
import { SESSION_GAME_LOGIC, SessionState, SessionGameLogic } from './gameSessions';
import { ForceOverride, RoundResult, WalletType } from '../../generated/prisma/client';

export function generateRawOutcome(
  serverSeed: string,
  clientSeed: string,
  nonce: number
): number {
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(`${clientSeed}:${nonce}`);
  const hash = hmac.digest('hex');
  return parseInt(hash.substring(0, 8), 16) / 0x100000000;
}

const MAX_SESSION_STEPS = 50; // hard safety cap for any session game

export interface SessionView {
  roundId: string;
  slug: string;
  betAmount: string;
  status: 'ACTIVE' | 'CASHOUT' | 'BUST';
  stepIndex: number;
  currentMultiplier: number;
  nextMultiplier: number;
  steps: unknown[];
  extra: Record<string, unknown>; // SANITIZED view (no mines/traps while active)
}

interface CreateParams {
  userId: string;
  slug: string;
  amount: Decimal;
  walletType: WalletType | 'AUTO';
  clientSeed: string;
  choices: Record<string, unknown>;
  requestId?: string;
  demo: boolean;
}

class SessionManagerImpl {
  private logic(slug: string): SessionGameLogic {
    const l = SESSION_GAME_LOGIC[slug];
    if (!l)
      throw new AppError(ERROR_CODES.GAME_NOT_FOUND, 404, 'Game has no session mode');
    return l;
  }

  /**
   * Active session for a user+game — DB truth (survives restarts).
   *
   * SECURITY: returns the RAW state, including `extra.mines` / `extra.trapsByFloor`.
   * This is SERVER-ONLY. Never return it over the wire — use `getActiveView()`,
   * which runs the state through `toView()` (strips the hidden answers).
   */
  private async getActiveState(
    userId: string,
    slug: string
  ): Promise<SessionState | null> {
    const round = await prisma.gameRound.findFirst({
      where: { userId, gameSlug: slug, result: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!round) return null;
    return this.stateFromRound(
      round.id,
      round.mappedOutcome as Record<string, unknown>
    );
  }

  /**
   * Client-safe view of the active session (timeout/refresh recovery).
   * SECURITY FIX: the recovery route used to return the raw SessionState, which
   * embedded `extra.mines` (Mines) and `extra.trapsByFloor` (Tower/Stairs) — a
   * player could read the answers mid-round and clear the board every time.
   */
  async getActiveView(userId: string, slug: string): Promise<SessionView | null> {
    const state = await this.getActiveState(userId, slug);
    return state ? this.toView(state) : null;
  }

  private stateFromRound(
    roundId: string,
    mapped: Record<string, unknown> | null
  ): SessionState | null {
    if (!mapped?.session) return null;
    return mapped.session as SessionState;
  }

  /**
   * Sanitize the internal state for the client (hide mines/traps until bust).
   *
   * ALLOW-LIST, not a deny-list: `state.extra` is server-only hidden state, so
   * anything not explicitly named here is withheld. A deny-list (`delete
   * extra.mines`) silently leaks the moment a new game adds a secret field.
   */
  private toView(state: SessionState): SessionView {
    const PUBLIC_EXTRA_KEYS = [
      'gridSize',
      'mineCount',
      'revealed', // mines (NOT `mines`)
      'difficulty',
      'cols',
      'trapsPerFloor',
      'floor', // tower (NOT `trapsByFloor`)
      'step',
      'choices',
      'safePerStep', // stairs
      'currentRank',
      'currentSuit',
      'streak',
      'mult', // hi-lo
    ] as const;
    const extra: Record<string, unknown> = {};
    for (const k of PUBLIC_EXTRA_KEYS) {
      if (k in state.extra) extra[k] = state.extra[k];
    }
    return {
      roundId: state.roundId,
      slug: state.slug,
      betAmount: state.betAmount,
      status: state.status,
      stepIndex: state.stepIndex,
      currentMultiplier: state.currentMultiplier,
      nextMultiplier: state.nextMultiplier,
      steps: state.steps,
      extra,
    };
  }

  async create(
    p: CreateParams
  ): Promise<{ session: SessionView; result: RoundResult | null }> {
    const logic = this.logic(p.slug);
    const config = await getGameConfig(p.slug);
    const seedPair = await prisma.seedPair.findFirstOrThrow({
      where: { userId: p.userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    if (p.clientSeed && p.clientSeed !== seedPair.clientSeed) {
      throw new AppError('SEED_MISMATCH', 400, 'Client seed mismatch — refresh seed');
    }

    // Idempotency: retrying the same requestId returns the existing session/settlement
    if (p.requestId) {
      const existing = await prisma.gameRound.findUnique({
        where: { userId_requestId: { userId: p.userId, requestId: p.requestId } },
      });
      if (existing) {
        if (existing.result === 'PENDING') {
          const st = this.stateFromRound(
            existing.id,
            existing.mappedOutcome as Record<string, unknown>
          );
          if (st) return { session: this.toView(st), result: null };
        }
        return {
          session: {
            roundId: existing.id,
            slug: p.slug,
            betAmount: existing.betAmount.toString(),
            status: existing.result === 'CASHOUT' ? 'CASHOUT' : 'BUST',
            stepIndex: 0,
            currentMultiplier: 0,
            nextMultiplier: 0,
            steps: [],
            extra: {},
          },
          result: existing.result,
        };
      }
    }

    // One active session per user+game
    const active = await this.getActiveState(p.userId, p.slug);
    if (active)
      throw new AppError(
        ERROR_CODES.GAME_ALREADY_BET_THIS_ROUND,
        409,
        'You already have a round in progress'
      );

    const rawOutcome = generateRawOutcome(
      seedPair.serverSeed,
      seedPair.clientSeed,
      seedPair.nonce
    );
    // Session API settlement never applies operator-forced outcomes. Direct
    // handler tests can still inject a ForceOverride explicitly, but a live
    // player session is always derived from the committed seed.
    const forceMode: ForceOverride = 'NONE';
    const init = logic.init(rawOutcome, p.choices, config, forceMode);
    const roundId = crypto.randomUUID();

    try {
      const state = await prisma.$transaction(async (tx) => {
        // H-17: serialize the loss-limit decision with stake acceptance.
        await responsiblePlayTxCheck(tx, p.userId, Number(p.amount));
        let deductedFrom: Array<{ type: WalletType; amount: Decimal }> = [];
        if (!p.demo) {
          ({ deductedFrom } = await deductBet(
            p.userId,
            p.amount,
            p.walletType,
            // H-18: ledger reference = the pre-minted round id.
            roundId,
            tx
          ));
        }
        const state: SessionState = {
          roundId,
          slug: p.slug,
          betAmount: p.amount.toFixed(2),
          clientSeed: seedPair.clientSeed,
          nonce: seedPair.nonce,
          rawOutcome,
          status: 'ACTIVE',
          stepIndex: 0,
          currentMultiplier: init.currentMultiplier,
          nextMultiplier: init.nextMultiplier,
          steps: [],
          extra: init.extra,
          configSnapshot: { ...config, configJson: config.configJson } as Record<
            string,
            unknown
          >,
          forceMode,
          demo: p.demo,
          createdAt: Date.now(),
          deductedFrom: deductedFrom.map((part) => ({
            type: part.type,
            amount: part.amount.toFixed(2),
          })),
        };
        // Initialized state and wallet debit commit together. There is no
        // PENDING {session:null} window that a process crash can strand.
        await tx.gameRound.create({
          data: {
            id: roundId,
            userId: p.userId,
            gameSlug: p.slug,
            betAmount: p.amount.toFixed(2),
            walletTypeUsed: p.demo ? 'REAL' : primaryWalletType(deductedFrom),
            requestId: p.requestId || undefined,
            choices: p.choices as never,
            seedPairId: seedPair.id,
            clientSeed: seedPair.clientSeed,
            nonce: seedPair.nonce,
            rawOutcome: new Decimal(rawOutcome).toFixed(16),
            mappedOutcome: { session: state } as never,
            result: 'PENDING',
            payoutMultiplier: '0',
            payoutAmount: '0',
            configSnapshot: { ...config, configJson: config.configJson } as never,
            configSnapshotHash: snapshotHash(config),
            forceUsed: 'NONE',
            demo: p.demo,
          },
        });
        // H-01: conditional nonce claim — a second concurrent session start
        // must fail and rollback instead of deriving a round from the same draw.
        const claimed = await tx.seedPair.updateMany({
          where: { id: seedPair.id, nonce: seedPair.nonce },
          data: { nonce: { increment: 1 } },
        });
        if (claimed.count !== 1)
          throw new AppError(
            ERROR_CODES.GAME_ALREADY_BET_THIS_ROUND,
            409,
            'Concurrent round in progress — please retry'
          );
        return state;
      });
      return { session: this.toView(state), result: null };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new AppError(
          ERROR_CODES.GAME_ALREADY_BET_THIS_ROUND,
          409,
          'You already have a round in progress'
        );
      }
      throw error;
    }
  }

  private async persist(
    state: SessionState,
    expectedStepIndex: number
  ): Promise<boolean> {
    const updated = await prisma.gameRound.updateMany({
      where: {
        id: state.roundId,
        result: 'PENDING',
        mappedOutcome: {
          path: ['session', 'stepIndex'],
          equals: expectedStepIndex,
        },
      },
      data: { mappedOutcome: { session: state } as never },
    });
    return updated.count === 1;
  }

  private async loadOwned(userId: string, roundId: string): Promise<SessionState> {
    const own = await prisma.gameRound.findFirst({
      where: { id: roundId, userId },
      orderBy: { createdAt: 'desc' },
    });
    if (!own)
      throw new AppError(ERROR_CODES.GAME_ROUND_NOT_FOUND, 404, 'Round not found');
    const st = this.stateFromRound(
      own.id,
      own.mappedOutcome as Record<string, unknown>
    );
    if (!st)
      throw new AppError(ERROR_CODES.GAME_ROUND_NOT_FOUND, 404, 'Round not found');
    return st;
  }

  async step(
    userId: string,
    slug: string,
    roundId: string,
    action: Record<string, unknown>
  ): Promise<{
    view: SessionView;
    stepResult: Record<string, unknown>;
    terminal: boolean;
  }> {
    const logic = this.logic(slug);
    const state = await this.loadOwned(userId, roundId);
    if (state.slug !== slug)
      throw new AppError(ERROR_CODES.GAME_ROUND_NOT_FOUND, 404, 'Round not found');
    if (state.status !== 'ACTIVE')
      throw new AppError(
        ERROR_CODES.GAME_ALREADY_BET_THIS_ROUND,
        409,
        'Round already finished'
      );
    if (state.stepIndex >= MAX_SESSION_STEPS)
      return this.finishByCashout(userId, state);

    // H-02: mid-round rules come from the round's OWN snapshot — an admin
    // editing a game while a ladder is open must never move open wagers.
    const config = (state.configSnapshot ?? (await getGameConfig(slug))) as Awaited<
      ReturnType<typeof getGameConfig>
    >;
    const out = logic.step(state, action, config);
    if (!out)
      throw new AppError(
        ERROR_CODES.GAME_INVALID_CHOICES,
        400,
        'Invalid step for this game'
      );

    const next: SessionState = {
      ...state,
      stepIndex: out.next.stepIndex,
      currentMultiplier: out.next.currentMultiplier,
      nextMultiplier: out.next.nextMultiplier,
      extra: out.next.extra,
      steps: [...state.steps, out.stepResult],
    };
    if (out.terminal) {
      // auto-win (all tiles dug / top reached / last step) → settle as cashout at
      // current multiplier; bust carries multiplier 0
      // C-02: pass the PRE-STEP stepIndex as the CAS expectation — the DB row
      // still carries the pre-step session, so the claim must not be made
      // against `next.stepIndex` (which was the C-02 root cause: every
      // terminal step failed the claim and the loss never persisted).
      return out.next.currentMultiplier > 0
        ? this.finishByCashout(userId, next, out.stepResult, state.stepIndex)
        : this.finishByBust(userId, next, out.stepResult, state.stepIndex);
    }
    const persisted = await this.persist(next, state.stepIndex);
    if (!persisted) {
      throw new AppError(
        ERROR_CODES.GAME_ALREADY_BET_THIS_ROUND,
        409,
        'Another action already advanced this round — refresh the board'
      );
    }
    return { view: this.toView(next), stepResult: out.stepResult, terminal: false };
  }

  async cashout(
    userId: string,
    slug: string,
    roundId: string
  ): Promise<{
    view: SessionView;
    stepResult: Record<string, unknown>;
    terminal: boolean;
  }> {
    const state = await this.loadOwned(userId, roundId);
    if (state.slug !== slug)
      throw new AppError(ERROR_CODES.GAME_ROUND_NOT_FOUND, 404, 'Round not found');
    if (state.status !== 'ACTIVE')
      throw new AppError(
        ERROR_CODES.GAME_ALREADY_BET_THIS_ROUND,
        409,
        'Round already finished'
      );
    return this.finishByCashout(userId, state);
  }

  /** Settle CASHOUT: payout = bet × currentMultiplier. */
  private async finishByCashout(
    userId: string,
    state: SessionState,
    lastStep?: Record<string, unknown>,
    expectedStepIndex = state.stepIndex
  ): Promise<{
    view: SessionView;
    stepResult: Record<string, unknown>;
    terminal: boolean;
  }> {
    // H-02: clamp by the snapshot's maxWinMultiplier and the global liability
    // ceiling — one-shots/WinGo/crash all do; sessions previously didn't.
    const snapshot = (state.configSnapshot ?? {}) as {
      maxWinMultiplier?: number | string;
    };
    const configuredMax = Number(snapshot.maxWinMultiplier ?? state.currentMultiplier);
    const cappedMultiplier = Math.min(state.currentMultiplier, configuredMax);
    const ceiling = await maxPayoutFor(state.slug).catch(() => null);
    const uncapped = money(state.betAmount).mul(cappedMultiplier).toDecimalPlaces(2);
    const payout = ceiling
      ? Decimal.min(uncapped, ceiling).toDecimalPlaces(2)
      : uncapped;
    const stepResult: Record<string, unknown> = lastStep ?? {
      cashout: true,
      currentMultiplier: state.currentMultiplier,
    };
    const final: SessionState = { ...state, status: 'CASHOUT' };
    await this.settle(userId, final, 'CASHOUT', payout, stepResult, expectedStepIndex);
    return { view: this.toView(final), stepResult, terminal: true };
  }

  /** Settle BUST: payout 0. */
  private async finishByBust(
    userId: string,
    state: SessionState,
    lastStep: Record<string, unknown>,
    expectedStepIndex = state.stepIndex
  ): Promise<{
    view: SessionView;
    stepResult: Record<string, unknown>;
    terminal: boolean;
  }> {
    const final: SessionState = { ...state, status: 'BUST' };
    await this.settle(userId, final, 'BUST', money(0), lastStep, expectedStepIndex);
    return { view: this.toView(final), stepResult: lastStep, terminal: true };
  }

  private async settle(
    userId: string,
    state: SessionState,
    result: 'CASHOUT' | 'BUST',
    payout: Decimal,
    stepResult: Record<string, unknown>,
    /** C-02: the stepIndex currently DURABLE in Postgres — the CAS claim must
     * match the pre-mutation session, not the in-memory final state. */
    expectedStepIndex: number
  ): Promise<void> {
    const terminalStepAlreadyAppended =
      !('cashout' in stepResult) && state.steps.length > 0;
    const finalSteps = terminalStepAlreadyAppended
      ? [
          ...state.steps.slice(0, -1),
          {
            ...(state.steps[state.steps.length - 1] as Record<string, unknown>),
            final: true,
          },
        ]
      : [...state.steps, { ...stepResult, final: true }];
    const finalState = { ...state, steps: finalSteps };
    const io = (globalThis as { __io?: import('socket.io').Server }).__io;
    // C-4: settle EXACTLY once, even under concurrent requests.
    //
    // The status was checked in memory and then this ran an unconditional
    // UPDATE. Two cashout requests racing on the same session both passed the
    // in-memory check and both paid — N parallel calls produced N payouts on a
    // single stake. Redis could not save it either: the check and the write
    // were not atomic with respect to each other.
    //
    // The fix is a conditional UPDATE. A live session row is created with
    // result 'PENDING' (see create()), and only a settlement moves it off that
    // value — so `where: { result: 'PENDING' }` is matched by exactly one
    // racer. The database picks the winner; everyone else sees count === 0 and
    // credits nothing.
    const settled = await prisma.$transaction(async (tx) => {
      const claim = await tx.gameRound.updateMany({
        where: {
          id: state.roundId,
          result: 'PENDING',
          // C-02: the row's stored session has the PRE-step index; claiming
          // against the incremented one made every terminal step a no-op.
          mappedOutcome: {
            path: ['session', 'stepIndex'],
            equals: expectedStepIndex,
          },
        },
        data: {
          result,
          payoutMultiplier: state.currentMultiplier.toFixed(4),
          payoutAmount: payout.toFixed(2),
          mappedOutcome: { session: finalState, finalStep: stepResult } as never,
        },
      });
      if (claim.count !== 1) return false; // another request already settled it
      if (payout.gt(0) && !state.demo) {
        const split = (state.deductedFrom ?? []).map((d) => ({
          type: d.type,
          amount: new Decimal(d.amount),
        }));
        await creditWinProRata(userId, split, payout, state.roundId, tx);
      }
      return true;
    });
    if (!settled) {
      throw new AppError(
        ERROR_CODES.GAME_ALREADY_BET_THIS_ROUND,
        409,
        'Round was already advanced or settled'
      );
    }
    if (!state.demo) {
      rotateSeedIfDue(userId, state.nonce + 1);
      await recordRound(
        state.slug,
        Number(state.betAmount),
        Number(payout),
        result === 'CASHOUT'
      );
      // M-07: an IMMEDIATE 1× cashout (session opened, cashed out with zero
      // game actions) is a full refund — no exposure, no volume. Counting it
      // farmed the wager-scored leaderboard at zero cost.
      const tookAction = state.stepIndex > 0;
      const fullRefund = Number(payout) === Number(state.betAmount);
      if (tookAction || !fullRefund) {
        void recordEngagement({
          userId,
          gameSlug: state.slug,
          betAmount: Number(state.betAmount),
          payoutAmount: Number(payout),
          isWin: result === 'CASHOUT',
          demo: false,
        });
      }
      emitAdmin('live-bet', {
        kind: 'bet',
        at: Date.now(),
        userId: shortId(userId),
        game: state.slug,
        betAmount: Number(state.betAmount),
        result,
        payoutAmount: Number(payout),
      });
    }
    if (io) {
      const snapshot = await getWalletSnapshot(userId).catch(() => null);
      if (snapshot) io.to(`user:${userId}`).emit('balance:update', snapshot);
    }
  }
}

export const sessionManager = new SessionManagerImpl();
