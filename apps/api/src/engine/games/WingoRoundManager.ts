// apps/api/src/engine/games/WingoRoundManager.ts — Wingo house-clock rounds (docs/19 §9)
// D-107: FOUR lottery times run continuously (30s / 1min / 3min / 5min) — one
// manager per duration, each looping forever whether or not anyone bets. Bets
// lock 5s before the draw; the last 5 seconds are a countdown for the client.
import Decimal from 'decimal.js';
import { redis, keys } from '../../db/redis';
import { prisma } from '../../db/prisma';
import { WalletType } from '../../../src/generated/prisma/client';
import { PROVABLY_FAIR } from '@casino/game-core/provably-fair';
import { getGameConfig, snapshotHash } from '../../services/gameConfig';
import {
  deductBet,
  creditWinProRata,
  primaryWalletType,
  getWalletSnapshot,
  applyBalanceChange,
} from '../../services/wallet';
import { recordRound } from '../StatisticsTracker';
import { recordEngagement } from '../../services/engagement';
import { money } from '@casino/shared/utils/money';
import { colorOf, isBig } from './WingoGame';
import { emitAdmin, shortId } from '../../lib/admin-feed';
import { RoundLeaderLease } from '../RoundLeaderLease';
import { refundOpenSharedBets } from '../../services/sharedRoundBets';
import { maxPayoutFor } from '../../services/stakeLimits';
import { responsiblePlayTxCheck } from '../../middleware';
import { resolveDifficulty, type DifficultyLevel } from '../difficulty';
import { AppError } from '../../lib/core';
import {
  DEFAULT_WINGO_PAYOUTS,
  pickWingoNumber,
  winningStakeByNumber,
  wingoMultiplier,
  type WingoPayouts,
} from './wingo-book';

export { DEFAULT_WINGO_PAYOUTS, wingoMultiplier };
export type { WingoPayouts };

export type WingoDurationSec = 30 | 60 | 180 | 300;
export const WINGO_DURATIONS: WingoDurationSec[] = [30, 60, 180, 300];
export const WINGO_LOCK_SEC = 5;

interface WingoRound {
  roundId: string;
  period: string;
  durationSec: number;
  status: 'BETTING' | 'DRAWING' | 'COMPLETE';
  endsAt: number;
  result: number | null;
  rawOutcome: number;
  serverSeedHash: string;
  serverSeed: string;
  /**
   * H-15: config AS OF ROUND START (weights, payout table, maxWin), so a
   * failover salvage and an admin mid-round edit both keep settling the round
   * under the rules it was bet under. Also what settlement writes into every
   * GameRound.configSnapshot — previously the LIVE config at settle time was
   * recorded instead.
   */
  configSnapshot?: Record<string, unknown>;
  configSnapshotHash?: string;
  /** Lock-time difficulty used to pick the ball. */
  difficulty?: DifficultyLevel;
  /** Winning-stake vector at lock (for PF replay). */
  bookStake?: number[];
  bets: Array<{
    userId: string;
    choice: string | number;
    amount: string;
    walletType: WalletType;
    /** H-3: which wallets actually funded the stake, so the win is credited back
     *  pro rata instead of landing entirely in REAL as withdrawable cash. */
    deductedFrom?: Array<{ type: WalletType; amount: string }>;
  }>;
}

export function durationKey(d: WingoDurationSec): '30s' | '60s' | '180s' | '300s' {
  return d === 60 ? '60s' : d === 180 ? '180s' : d === 300 ? '300s' : '30s';
}

/** WinGo period number, e.g. 20260815000000042 (date + 9-digit daily sequence). */
export async function nextPeriod(
  now = Date.now(),
  durationSec?: WingoDurationSec
): Promise<string> {
  const d = new Date(now);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  // v1.3.3: the daily sequence is PER DURATION. The four lotteries used to
  // share one counter, so the 30s board's period numbers visibly jumped (e.g.
  // …3111 → …3114) whenever a 1-Min/3-Min/5-Min round started in between —
  // players read that as skipped/missing rounds. The reference game numbers
  // each lottery time independently.
  const suffix = durationSec ? `:${durationSec}` : '';
  try {
    const seq = await redis.incr(`wingo:period:seq:${ymd}${suffix}`);
    return `${ymd}${String(seq).padStart(9, '0')}`;
  } catch {
    // redis down — time-based fallback so the period still looks right
    return `${ymd}${String(Math.floor(now / 1000) % 1000000000).padStart(9, '0')}`;
  }
}

export class WingoRoundManager {
  private io?: import('socket.io').Server;
  private timer: NodeJS.Timeout | null = null;
  private looping = false;
  private readonly lease: RoundLeaderLease;
  /** rolling window of last 100 round results for this duration's trend grid */
  private history: Array<{
    number: number;
    color: string;
    period: string;
    at: number;
  }> = [];

  constructor(private durationSec: WingoDurationSec) {
    this.lease = new RoundLeaderLease(`leader:round:wingo:${durationSec}`);
  }

  get duration(): number {
    return this.durationSec;
  }

  async start(io: import('socket.io').Server) {
    this.io = io;
    this.lease.start(
      () => {
        if (!this.looping) {
          this.looping = true;
          this.runLoopSafe();
        }
      },
      () => this.pauseLoop()
    );
  }
  stop() {
    void this.lease.stop(() => this.pauseLoop());
  }

  private runLoopSafe() {
    void this.loop().catch((error) => {
      console.error(
        `[wingo:${this.durationSec}] round loop error:`,
        (error as Error).stack || error
      );
      if (this.looping && this.lease.isLeader()) {
        this.timer = setTimeout(() => this.runLoopSafe(), 1000);
      }
    });
  }

  private pauseLoop() {
    this.looping = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private key() {
    return keys.wingoRound(durationKey(this.durationSec));
  }

  private historyKey() {
    return `wingo:history:${this.durationSec}`;
  }

  private async pushHistory(entry: {
    number: number;
    color: string;
    period: string;
    at: number;
  }) {
    this.history.push(entry);
    if (this.history.length > 100) this.history.shift();
    try {
      // D-108: paginated "Game history" must reach far back. 1000 rounds used
      // to be all we kept — on the 30s board that is ~8 HOURS of history, and
      // everything older silently vanished for players (v1.3.5·§7). ~80 bytes
      // a row means 100k rounds ≈ 8MB per board — cheap insurance.
      await redis.rpush(this.historyKey(), JSON.stringify(entry));
      await redis.ltrim(this.historyKey(), -WINGO_HISTORY_MAX, -1);
    } catch {
      /* history is cosmetic — never break a round over it */
    }
  }

  recentResults(): Array<{
    number: number;
    color: string;
    period: string;
    at: number;
  }> {
    return this.history.slice();
  }

  /** snapshot of the current round for the lobby/panel (no secrets: result hidden) */
  async currentRound(): Promise<{
    roundId: string;
    period: string;
    durationSec: number;
    status: string;
    endsAt: number;
    bettingOpen: boolean;
    remainingSec: number;
    serverSeedHash: string;
  } | null> {
    try {
      const raw = await redis.get(this.key());
      if (!raw) return null;
      const r = JSON.parse(raw) as WingoRound;
      const remainingSec = Math.max(0, Math.ceil((r.endsAt - Date.now()) / 1000));
      return {
        roundId: r.roundId,
        period: r.period,
        durationSec: r.durationSec,
        status: r.status,
        endsAt: r.endsAt,
        bettingOpen: r.status === 'BETTING' && remainingSec > WINGO_LOCK_SEC,
        remainingSec,
        serverSeedHash: r.serverSeedHash,
      };
    } catch {
      return null;
    }
  }

  private async loop() {
    if (!this.looping || !this.lease.isLeader()) return;
    // H-15: a new leader must SALVAGE an interrupted round with a committed
    // result (settle the known outcome) before refunding anything — the old
    // unconditional refund turned KNOWN winners into stakes-back.
    await this.salvageInterruptedRound();
    // Only result-less stakes are ever refunded now.
    await refundOpenSharedBets('wingo', this.durationSec);
    const config = await getGameConfig('wingo');
    const seed = PROVABLY_FAIR.generateServerSeed();
    const rawOutcome = PROVABLY_FAIR.generateRawOutcome(seed, 'wingo', 0);
    const configSnapshot = JSON.parse(JSON.stringify(config)) as Record<
      string,
      unknown
    >;
    const cj = (configSnapshot.configJson ?? {}) as Record<string, unknown>;
    configSnapshot.configJson = { ...cj, payouts: { ...DEFAULT_WINGO_PAYOUTS } };
    const round: WingoRound = {
      roundId: crypto.randomUUID(),
      period: await nextPeriod(Date.now(), this.durationSec),
      durationSec: this.durationSec,
      status: 'BETTING',
      endsAt: Date.now() + this.durationSec * 1000,
      result: null,
      rawOutcome,
      serverSeed: seed,
      serverSeedHash: PROVABLY_FAIR.hashServerSeed(seed),
      // H-15: pin the settlement rules to THIS round from the moment it opens
      // (JSON round-trip makes it storage-stable; the hash is computed on the
      // deep-sorted canonical form, so it survives jsonb/redis reordering).
      configSnapshot,
      configSnapshotHash: snapshotHash(configSnapshot as never),
      bets: [],
    };
    // Seed hash is public at open. The ball is chosen at lock from the book
    // + HMAC (easy/normal = uniform HMAC; hard/impossible fade the cheapest
    // winning-stake digit). result stays null until then.
    await redis.set(this.key(), JSON.stringify(round));
    // `serverNow` lets the client compute `endsAt - serverNow` and drive its own
    // countdown from that offset. Using the browser clock directly meant any
    // device with a skewed clock showed the wrong time immediately.
    this.io?.emit('wingo:round-start', {
      roundId: round.roundId,
      period: round.period,
      durationSec: this.durationSec,
      endsAt: round.endsAt,
      serverNow: Date.now(),
      serverSeedHash: round.serverSeedHash,
    });

    // bet lock 5s before draw (docs/19 §9) — the last 5 seconds are a countdown.
    //
    // H-14: the reveal must land EXACTLY when the clients' countdown hits zero.
    // Previously the timer fired at duration−5s, slept a FLAT 3s, and revealed
    // ~2s early (while the user's clock still showed time left) — then chained
    // the next round ANOTHER 5s later, so rounds actually cycled at
    // duration+5s. Now: betting closes at endsAt−lock, the reveal sleeps until
    // endsAt (whatever the remaining time is), and the next round starts on the
    // period boundary.
    this.timer = setTimeout(
      async () => {
        let current: WingoRound | null = null;
        try {
          current = JSON.parse((await redis.get(this.key()))!) as WingoRound;
          // Redis status must say DRAWING — late joiners previously read a
          // "BETTING" state while the board was already animating.
          current.status = 'DRAWING';
          await this.commitResult(current);
          await redis.set(this.key(), JSON.stringify(current));
          this.io?.emit('wingo:betting-closed', {
            roundId: current.roundId,
            durationSec: this.durationSec,
          });
          // Sleep UP TO endsAt exactly — historically a flat 3s here revealed
          // the number ~2s before the displayed zero.
          await sleep(Math.max(0, current.endsAt - Date.now()));

          const result = current.result!;
          const color = colorOf(result);
          this.io?.emit('wingo:result', {
            roundId: current.roundId,
            period: current.period,
            durationSec: this.durationSec,
            result,
            color,
            serverSeed: current.serverSeed,
          });
          await this.pushHistory({
            number: result,
            color,
            period: current.period,
            at: Date.now(),
          });

          await this.settleRound(current);
        } catch (e) {
          console.error(
            `[wingo] round ${current?.roundId ?? '?'} settlement aborted:`,
            (e as Error).stack || e
          );
        } finally {
          // H-14 chains the next round ON THE ROUND'S OWN CLOCK — settlement
          // above must never delay the next period. Just as important: this
          // chain used to live INSIDE the try, so one transient Redis error at
          // draw time silently killed the whole lottery until a restart. The
          // cycle continuing is the primary product promise ("one game for
          // everyone, constantly running"); un-settled stakes from the failed
          // round are settled/refunded by the next loop()'s salvage pass.
          if (this.looping && this.lease.isLeader()) {
            this.timer = setTimeout(
              () => this.runLoopSafe(),
              Math.max(250, (current?.endsAt ?? Date.now()) - Date.now())
            );
          }
        }
      },
      (this.durationSec - WINGO_LOCK_SEC) * 1000
    );
  }

  /**
   * Choose the ball from the locked book + HMAC. Idempotent: a crash after
   * commit keeps the same digit because HMAC is a function of the seed.
   */
  private async commitResult(current: WingoRound): Promise<void> {
    if (current.result !== null && current.result !== undefined) return;
    const bets = await prisma.sharedRoundBet.findMany({
      where: { gameSlug: 'wingo', roundId: current.roundId, status: 'PLACED' },
      select: { choice: true, amount: true },
    });
    const winningStake = winningStakeByNumber(bets);
    let level: DifficultyLevel = 'normal';
    try {
      const snap = current.configSnapshot as
        { configJson?: Record<string, unknown> } | undefined;
      level = await resolveDifficulty({
        configJson: (snap?.configJson ?? {}) as never,
      } as never);
    } catch {
      level = 'normal';
    }
    const uPick = PROVABLY_FAIR.generateRawOutcome(current.serverSeed, 'wingo', 1);
    current.result = pickWingoNumber({
      level,
      winningStake,
      uGate: current.rawOutcome,
      uPick,
    });
    current.difficulty = level;
    current.bookStake = winningStake;
  }

  /**
   * Persist the completed round so a leader takeover can salvage leftover
   * stakes even after the live key rotated to a new round (H-15).
   */
  private async markCompleted(current: WingoRound): Promise<void> {
    current.status = 'COMPLETE';
    await redis.set(this.key(), JSON.stringify(current));
    try {
      await redis.set(
        `${this.key()}:last`,
        JSON.stringify(current),
        'EX',
        Math.max(120, this.durationSec * 2)
      );
    } catch {
      /* salvage backstop best-effort */
    }
  }

  /**
   * H-15: settle (or, as an absolute last resort, refund) every PLACED bet of
   * a round with a COMMITTED result, under the round's own start-of-round
   * config — never against whatever an admin may have edited mid-round.
   */
  private async settleRound(current: WingoRound): Promise<void> {
    if (current.result === null || current.result === undefined) return;
    const result = current.result;
    const color = colorOf(result);
    // Flat 1.96× — difficulty fades the ball, never the price.
    const snapshot = (current.configSnapshot ?? {}) as {
      maxWinMultiplier?: number | string;
    };
    const payouts: WingoPayouts = { ...DEFAULT_WINGO_PAYOUTS };
    const maxWinMultiplier = Number(
      snapshot.maxWinMultiplier ?? Number.MAX_SAFE_INTEGER
    );
    const payoutCeiling = await maxPayoutFor('wingo');
    // PostgreSQL is the source of truth for accepted bets. Redis contains no
    // money-bearing bet list, so concurrent placements and process restarts
    // cannot erase a debited stake.
    const bets = await prisma.sharedRoundBet.findMany({
      where: { gameSlug: 'wingo', roundId: current.roundId, status: 'PLACED' },
      orderBy: { createdAt: 'asc' },
    });
    // v1.3.5·§3: ONE balance:update per user per round, emitted after ALL of
    // their stacked bets settled. Seven stacked targets previously produced
    // seven creeping balance events — the player watched only the FIRST of
    // their wins land at the most emotional moment.
    const settledUsers = new Set<string>();
    for (const bet of bets) {
      try {
        const choice =
          typeof bet.choice === 'number' || typeof bet.choice === 'string'
            ? bet.choice
            : '';
        const won =
          choice === result ||
          choice === color ||
          (choice === 'big' && isBig(result)) ||
          (choice === 'small' && !isBig(result));
        const nominalMultiplier = won
          ? Math.min(wingoMultiplier(choice, payouts), maxWinMultiplier)
          : 0;
        const uncappedPayout = money(bet.amount)
          .mul(nominalMultiplier)
          .toDecimalPlaces(2);
        const payout = Decimal.min(uncappedPayout, payoutCeiling).toDecimalPlaces(2);
        const mult = payout.div(money(bet.amount)).toDecimalPlaces(4).toNumber();
        const roundResult: 'WIN' | 'LOSE' | 'PUSH' = payout.gt(bet.amount)
          ? 'WIN'
          : payout.eq(bet.amount)
            ? 'PUSH'
            : 'LOSE';

        const settled = await prisma.$transaction(async (tx) => {
          // Conditional claim + settlement are one transaction. On any error
          // the status remains PLACED for reconciliation/retry.
          const claim = await tx.sharedRoundBet.updateMany({
            where: { id: bet.id, status: 'PLACED' },
            data: { status: 'SETTLING' },
          });
          if (claim.count !== 1) return null;

          const seedPair = await tx.seedPair.findFirstOrThrow({
            where: { userId: bet.userId, status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
          });
          const mappedOutcome = {
            number: result,
            color,
            choice,
            win: roundResult === 'WIN',
            push: roundResult === 'PUSH',
            multiplier: mult,
            payout: payout.toNumber(),
            pf: {
              algorithm: 'wingo-hmac-v1',
              serverSeed: current.serverSeed,
              serverSeedHash: current.serverSeedHash,
              clientSeed: 'wingo',
              nonce:
                current.difficulty === 'hard' || current.difficulty === 'impossible'
                  ? 1
                  : 0,
              rawOutcome: current.rawOutcome,
              difficulty: current.difficulty ?? 'normal',
              bookStake: current.bookStake ?? [],
            },
          };
          const roundRow = await tx.gameRound.create({
            data: {
              userId: bet.userId,
              gameSlug: 'wingo',
              betAmount: bet.amount.toFixed(2),
              walletTypeUsed: bet.walletType,
              requestId: bet.requestId,
              choices: { choice, durationSec: current.durationSec } as never,
              seedPairId: seedPair.id,
              clientSeed: 'wingo',
              nonce: 0,
              rawOutcome: money(current.rawOutcome).toFixed(16),
              mappedOutcome: mappedOutcome as never,
              result: roundResult,
              payoutMultiplier: mult.toFixed(4),
              payoutAmount: payout.toFixed(2),
              // H-15: the round-START config — mid-round edits never touch
              // this round's wager price or its verification snapshot.
              configSnapshot: (current.configSnapshot ?? {}) as never,
              configSnapshotHash: current.configSnapshotHash ?? '',
              forceUsed: 'NONE',
            },
          });
          if (payout.gt(0)) {
            const split = (
              bet.deductedFrom as Array<{ type: WalletType; amount: string }>
            ).map((part) => ({ type: part.type, amount: money(part.amount) }));
            await creditWinProRata(bet.userId, split, payout, roundRow.id, tx);
          }
          await tx.sharedRoundBet.update({
            where: { id: bet.id },
            data: {
              status: 'SETTLED',
              result: roundResult,
              payoutMultiplier: mult.toFixed(4),
              payoutAmount: payout.toFixed(2),
              settledAt: new Date(),
            },
          });
          return roundRow;
        });
        if (!settled) continue;
        settledUsers.add(bet.userId);

        await recordRound(
          'wingo',
          Number(bet.amount),
          payout.toNumber(),
          roundResult === 'WIN'
        );
        // M-07: Wingo was the only real-money game NOT feeding engagement —
        // its wager volume never reached leaderboards or the live feed.
        void recordEngagement({
          userId: bet.userId,
          gameSlug: 'wingo',
          betAmount: Number(bet.amount),
          payoutAmount: payout.toNumber(),
          isWin: roundResult === 'WIN',
          demo: false,
        });
        emitAdmin('live-bet', {
          kind: 'bet',
          at: Date.now(),
          userId: shortId(bet.userId),
          game: 'wingo',
          betAmount: Number(bet.amount),
          result: roundResult,
          payoutAmount: payout.toNumber(),
        });
        this.io?.to(`user:${bet.userId}`).emit('wingo:my-result', {
          roundId: current.roundId,
          period: current.period,
          durationSec: current.durationSec,
          choice,
          betAmount: Number(bet.amount),
          result: roundResult,
          multiplier: mult,
          payout: payout.toNumber(),
          number: result,
          color,
        });
        // (balance:update intentionally NOT emitted per bet — see §3 above;
        //  one final snapshot per user goes out after the whole round settles)
      } catch (error) {
        // H-15: never REFUND a stake whose result is already committed —
        // retry the settlement once after a beat; only if THAT fails do we
        // refund, and we refund explicitly (not via the bulk interrupt path
        // pretending the round never happened).
        console.error(
          `[wingo] settle failed for ${bet.userId} (round ${current.roundId}) — retrying once:`,
          (error as Error).message
        );
        await sleep(500);
        try {
          // rerun this single bet through the normal loop body by rethrow-able
          // recursion is overkill — retry via the same settle path:
          const retry = await prisma.sharedRoundBet.findUnique({
            where: { id: bet.id },
          });
          if (retry && retry.status === 'PLACED') {
            await this.settleSingleBet(
              retry,
              current,
              result,
              color,
              payouts,
              maxWinMultiplier,
              payoutCeiling
            );
          }
        } catch (retryErr) {
          console.error(
            `[wingo] settle retry failed for ${bet.userId} — refunding stake explicitly:`,
            (retryErr as Error).message
          );
          await this.refundSingleBet(bet, current).catch((refundErr) =>
            console.error(
              '[wingo] refund failed, bet stays PLACED for ops:',
              (refundErr as Error).message
            )
          );
        }
      }
    }
    // §3: settle events (wingo:my-result) stream per bet for the banner's
    // per-target rows, but the wallet number is pushed EXACTLY once per user —
    // with every one of their wins already inside it.
    for (const uid of settledUsers) {
      try {
        const snapshot = await getWalletSnapshot(uid);
        this.io?.to(`user:${uid}`).emit('balance:update', snapshot);
      } catch {
        /* the next REST refresh reconciles */
      }
    }
    // Only flip COMPLETE once every PLACED stake has an outcome.
    await this.markCompleted(current);
  }

  /** Single-bet retry body for settleRound's catch path (identical logic). */
  private async settleSingleBet(
    bet: Parameters<typeof prisma.sharedRoundBet.findUnique>[0] extends never
      ? never
      : Awaited<ReturnType<typeof prisma.sharedRoundBet.findFirstOrThrow>> & {
          deductedFrom: unknown;
        },
    current: WingoRound,
    result: number,
    color: 'red' | 'green' | 'violet',
    payouts: WingoPayouts,
    maxWinMultiplier: number,
    payoutCeiling: Decimal
  ): Promise<boolean> {
    const choice =
      typeof bet.choice === 'number' || typeof bet.choice === 'string'
        ? bet.choice
        : '';
    const won =
      choice === result ||
      choice === color ||
      (choice === 'big' && isBig(result)) ||
      (choice === 'small' && !isBig(result));
    const nominalMultiplier = won
      ? Math.min(wingoMultiplier(choice, payouts), maxWinMultiplier)
      : 0;
    const uncappedPayout = money(bet.amount).mul(nominalMultiplier).toDecimalPlaces(2);
    const payout = Decimal.min(uncappedPayout, payoutCeiling).toDecimalPlaces(2);
    const mult = payout.div(money(bet.amount)).toDecimalPlaces(4).toNumber();
    const roundResult: 'WIN' | 'LOSE' | 'PUSH' = payout.gt(bet.amount)
      ? 'WIN'
      : payout.eq(bet.amount)
        ? 'PUSH'
        : 'LOSE';
    const claimed = await prisma.$transaction(async (tx) => {
      const claim = await tx.sharedRoundBet.updateMany({
        where: { id: bet.id, status: 'PLACED' },
        data: { status: 'SETTLING' },
      });
      if (claim.count !== 1) return false;
      const seedPair = await tx.seedPair.findFirstOrThrow({
        where: { userId: bet.userId, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
      });
      const roundRow = await tx.gameRound.create({
        data: {
          userId: bet.userId,
          gameSlug: 'wingo',
          betAmount: bet.amount.toFixed(2),
          walletTypeUsed: bet.walletType,
          requestId: bet.requestId,
          choices: { choice, durationSec: current.durationSec } as never,
          seedPairId: seedPair.id,
          clientSeed: 'wingo',
          nonce: 0,
          rawOutcome: money(current.rawOutcome).toFixed(16),
          mappedOutcome: {
            number: result,
            color,
            choice,
            win: roundResult === 'WIN',
            push: roundResult === 'PUSH',
            multiplier: mult,
            payout: payout.toNumber(),
            pf: {
              algorithm: 'wingo-hmac-v1',
              serverSeed: current.serverSeed,
              serverSeedHash: current.serverSeedHash,
              clientSeed: 'wingo',
              nonce:
                current.difficulty === 'hard' || current.difficulty === 'impossible'
                  ? 1
                  : 0,
              rawOutcome: current.rawOutcome,
              difficulty: current.difficulty ?? 'normal',
              bookStake: current.bookStake ?? [],
            },
          } as never,
          result: roundResult,
          payoutMultiplier: mult.toFixed(4),
          payoutAmount: payout.toFixed(2),
          configSnapshot: (current.configSnapshot ?? {}) as never,
          configSnapshotHash: current.configSnapshotHash ?? '',
          forceUsed: 'NONE',
        },
      });
      if (payout.gt(0)) {
        const split = (
          bet.deductedFrom as unknown as Array<{ type: WalletType; amount: string }>
        ).map((part) => ({ type: part.type, amount: money(part.amount) }));
        await creditWinProRata(bet.userId, split, payout, roundRow.id, tx);
      }
      await tx.sharedRoundBet.update({
        where: { id: bet.id },
        data: {
          status: 'SETTLED',
          result: roundResult,
          payoutMultiplier: mult.toFixed(4),
          payoutAmount: payout.toFixed(2),
          settledAt: new Date(),
        },
      });
      return true;
    });
    if (!claimed) return false;

    // v1.3.5·§8: the recovery path must ANNOUNCE exactly like the happy path —
    // previously a retried/salvaged settle paid the wallet silently: no
    // banner, no balance push, nothing. One late truth beats silent money.
    await recordRound(
      'wingo',
      Number(bet.amount),
      payout.toNumber(),
      roundResult === 'WIN'
    );
    void recordEngagement({
      userId: bet.userId,
      gameSlug: 'wingo',
      betAmount: Number(bet.amount),
      payoutAmount: payout.toNumber(),
      isWin: roundResult === 'WIN',
      demo: false,
    });
    this.io?.to(`user:${bet.userId}`).emit('wingo:my-result', {
      roundId: current.roundId,
      period: current.period,
      durationSec: current.durationSec,
      choice,
      betAmount: Number(bet.amount),
      result: roundResult,
      multiplier: mult,
      payout: payout.toNumber(),
      number: result,
      color,
      recovered: true,
    });
    try {
      this.io
        ?.to(`user:${bet.userId}`)
        .emit('balance:update', await getWalletSnapshot(bet.userId));
    } catch {
      /* reconcile via REST */
    }
    return true;
  }

  /** Explicit per-bet refund — settleRound's last resort (H-15). */
  private async refundSingleBet(
    bet: {
      id: string;
      userId: string;
      deductedFrom: unknown;
      gameSlug: string;
      roundId?: string;
      durationSec?: number | null;
      choice?: unknown;
      amount?: { toString(): string } | number | string;
    },
    round?: WingoRound
  ): Promise<void> {
    const refunded = await prisma.$transaction(async (tx) => {
      const claim = await tx.sharedRoundBet.updateMany({
        where: { id: bet.id, status: { in: ['PLACED', 'SETTLING'] } },
        data: { status: 'SETTLING' },
      });
      if (claim.count !== 1) return false;
      const split = (bet.deductedFrom ?? []) as Array<{
        type: WalletType;
        amount: string;
      }>;
      for (const part of split) {
        await applyBalanceChange(
          bet.userId,
          part.type,
          money(part.amount),
          'REFUND',
          {
            referenceType: 'shared_round_bet',
            referenceId: bet.id,
            description: 'wingo settlement failed after retry — stake refunded',
          },
          tx
        );
      }
      await tx.sharedRoundBet.update({
        where: { id: bet.id },
        data: { status: 'REFUNDED' as never, settledAt: new Date() },
      });
      return true;
    });
    if (!refunded) return;
    // v1.3.5·§8: even a REFUND tells the player — money showing up silently
    // looks the same as money vanishing silently ("the round just vanished").
    // result 'REFUND' renders a neutral "stake returned" card on the client.
    const amt = Number(
      typeof bet.amount === 'object' ? String(bet.amount) : Number(bet.amount ?? 0)
    );
    this.io?.to(`user:${bet.userId}`).emit('wingo:my-result', {
      roundId: bet.roundId ?? round?.roundId ?? '',
      period: round?.period ?? '',
      durationSec: bet.durationSec ?? round?.durationSec ?? 0,
      choice: (bet.choice as string | number | undefined) ?? '—',
      betAmount: Number.isFinite(amt) ? amt : 0,
      result: 'REFUND',
      multiplier: 0,
      payout: 0,
      number: round?.result ?? null,
      color:
        round?.result !== null && round?.result !== undefined
          ? colorOf(round.result)
          : '',
      refunded: Number.isFinite(amt) ? amt : 0,
    });
    try {
      this.io
        ?.to(`user:${bet.userId}`)
        .emit('balance:update', await getWalletSnapshot(bet.userId));
    } catch {
      /* reconcile via REST */
    }
  }

  /**
   * H-15: on leader takeover, settle interrupted-but-COMMITTED rounds before
   * refundOpenSharedBets touches anything.
   */
  private async salvageInterruptedRound(): Promise<void> {
    const seen = new Set<string>();
    for (const k of [this.key(), `${this.key()}:last`]) {
      const raw = await redis.get(k).catch(() => null);
      if (!raw) continue;
      let round: WingoRound;
      try {
        round = JSON.parse(raw) as WingoRound;
      } catch {
        continue;
      }
      if (!round?.roundId || seen.has(round.roundId)) continue;
      seen.add(round.roundId);
      if (round.result === null || round.result === undefined) {
        const lockAt = round.endsAt - WINGO_LOCK_SEC * 1000;
        if (round.status === 'DRAWING' || Date.now() >= lockAt) {
          try {
            await this.commitResult(round);
            await redis.set(this.key(), JSON.stringify(round));
          } catch (err) {
            console.error('[wingo] salvage commit failed:', (err as Error).message);
            continue;
          }
        } else {
          continue;
        }
      }
      if (round.result === null || round.result === undefined) continue;
      if (round.status === 'COMPLETE') {
        // ":last" entry — only relevant if bets were still left over.
      }
      const leftover = await prisma.sharedRoundBet.count({
        where: { gameSlug: 'wingo', roundId: round.roundId, status: 'PLACED' },
      });
      if (leftover === 0) continue;
      console.warn(
        `[wingo] salvaging interrupted round ${round.roundId} (${leftover} open stakes, result ${round.result})`
      );
      await this.settleRound(round).catch((err) =>
        console.error('[wingo] salvage failed:', (err as Error).message)
      );
    }
  }

  /** Place a durable bet into the current round. Wallet debit + placement row are atomic. */
  async placeBet(
    userId: string,
    choice: string | number,
    amount: number,
    requestId: string,
    roundId?: string
  ): Promise<{
    roundId: string;
    ok: boolean;
    message?: string;
    code?: string;
    statusCode?: number;
    newBalance?: { real: string; bonus: string; gifted: string; locked: string };
  }> {
    const raw = await redis.get(this.key());
    if (!raw)
      return { roundId: '', ok: false, message: 'No active round — wait a moment' };
    const round = JSON.parse(raw) as WingoRound;
    if (round.status !== 'BETTING')
      return {
        roundId: round.roundId,
        ok: false,
        message: 'Round is drawing — wait for the next one',
      };
    if (roundId && round.roundId !== roundId)
      return {
        roundId: round.roundId,
        ok: false,
        message: 'Round changed — please retry',
      };
    if (Date.now() > round.endsAt - WINGO_LOCK_SEC * 1000) {
      return {
        roundId: round.roundId,
        ok: false,
        message: 'Betting is closed — wait for the next round',
      };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { roundId: round.roundId, ok: false, message: 'Invalid bet amount' };
    }

    // Dedupe per TARGET, not per round: real WinGo lets a player stack several
    // bets into one period (e.g. Red + number 7 + Big). The old check treated
    // ANY existing bet in this round as "already placed", which silently turned
    // every follow-up bet into a no-op. Now only the SAME choice on the SAME
    // round (a double-tap retry with a fresh requestId) short-circuits;
    // different choices ride the normal path and debit again.
    const existing = await prisma.sharedRoundBet.findFirst({
      where: {
        userId,
        OR: [
          { requestId },
          {
            gameSlug: 'wingo',
            roundId: round.roundId,
            choice: { equals: choice as never },
          },
        ],
      },
    });
    if (existing) {
      return {
        roundId: existing.roundId,
        ok: true,
        newBalance: await getWalletSnapshot(userId),
      };
    }

    let newBalance:
      { real: string; bonus: string; gifted: string; locked: string } | undefined;
    try {
      newBalance = await prisma.$transaction(async (tx) => {
        // H-17: serialize the loss-limit decision with stake acceptance
        // (locks the user row; counts open WinGo/crash/session exposure).
        await responsiblePlayTxCheck(tx, userId, Number(amount));
        const deducted = await deductBet(userId, money(amount), 'AUTO', requestId, tx);
        const split = deducted.deductedFrom.map((part) => ({
          type: part.type,
          amount: part.amount.toFixed(2),
        }));
        await tx.sharedRoundBet.create({
          data: {
            userId,
            gameSlug: 'wingo',
            roundId: round.roundId,
            durationSec: this.durationSec,
            requestId,
            amount: money(amount).toFixed(2),
            walletType: primaryWalletType(deducted.deductedFrom),
            deductedFrom: split as never,
            choice: choice as never,
          },
        });
        return deducted.snapshot;
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') {
        return {
          roundId: round.roundId,
          ok: true,
          newBalance: await getWalletSnapshot(userId),
        };
      }
      // Do not mask RESP_001 / WAL_001 / 5xx as "insufficient balance".
      if (error instanceof AppError) {
        return {
          roundId: round.roundId,
          ok: false,
          message: error.message,
          code: String(error.code),
          statusCode: error.statusCode,
        };
      }
      console.error('[wingo] placeBet failed:', (error as Error).stack || error);
      return {
        roundId: round.roundId,
        ok: false,
        message: 'Could not place bet — try again',
      };
    }

    // Do not broadcast choice/amount. Hard/impossible pick the cheapest
    // winning-stake digit at lock — a room-wide ticker would let anyone
    // rebuild the book during the betting window. The better already gets
    // their own ack. Round is still one ball for everyone.
    return { roundId: round.roundId, ok: true, newBalance };
  }
}

/** Persisted (player-visible) history cap per lottery board — see §7. */
export const WINGO_HISTORY_MAX = 100_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
import crypto from 'crypto';
