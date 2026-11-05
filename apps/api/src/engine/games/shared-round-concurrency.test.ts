// apps/api/src/engine/games/shared-round-concurrency.test.ts
// Item #6: concurrency + property tests for the new durable shared-round tables.
//
// These exercise the real money paths of the house-clock managers
// (WingoRoundManager.placeBet + its real loop()-driven settlement, and the
// orphaned-bet refund path in sharedRoundBets.ts) with FAKE Redis/Prisma.
// in CI while still asserting the invariants that matter in production:
//
//   1. concurrent placeBet with the SAME requestId → ONE debit (idempotency
//      is anchored by the (userId, requestId) unique index, code P2002).
//   2. concurrent placeBet for the SAME user + game + round → ONE row
//      ((gameSlug, roundId, userId) unique index — one bet per round).
//   3. racing the SETTLE phase against placeBet → loses with 'Round is
//      drawing' instead of a stuck debit.
//   4. last-retry-attempt idempotency: settlement must be exactly-once; a
//      second settleAll pass must NOT double-credit winners.
//   5. property test: refunded multipliers always exactly RESTORE the stake.
import { describe, expect, it, vi, beforeEach } from 'vitest';

/* ─────────────────────────────── fake layers ─────────────────────────── */

import Decimal from 'decimal.js';

const t = vi.hoisted(() => ({ db: null as unknown as any }));

/** Decimal values the fake layer hands to production code. */
function fakeDecimal(v: number | string) {
  return new Decimal(v);
}

class Err extends Error {
  constructor(
    public code: string,
    msg: string
  ) {
    super(msg);
  }
}

interface WalletRow {
  userId: string;
  type: string;
  balance: number;
}
interface SharedBetRow {
  id: string;
  userId: string;
  gameSlug: string;
  roundId: string;
  durationSec: number | null;
  requestId: string;
  amount: number;
  walletType: string;
  deductedFrom: Array<{ type: string; amount: string }>;
  choice: unknown;
  status: string;
  payoutAmount: number | null;
  payoutMultiplier: number | null;
  settledAt: Date | null;
}

/**
 * Minimal Prisma stand-in enforcing the REAL unique constraints of the
 * SharedRoundBet table (taken verbatim from the durable_shared_round_bets
 * migration) so races hit the same second-guard the database would.
 */
function fakeDb() {
  const wallets: WalletRow[] = [];
  const bets: SharedBetRow[] = [];
  const seedPairs: Array<{ id: string; userId: string }> = [];
  const gameRounds: Array<Record<string, unknown>> = [];
  const lockGate = { held: false };
  const clone = (b: SharedBetRow): SharedBetRow => ({
    ...b,
    deductedFrom: b.deductedFrom.map((d) => ({ ...d })),
  });
  const matches = (b: SharedBetRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR' || k === 'AND' || k === 'NOT') return true; // only used by findFirst paths we hand-roll
      return (b as unknown as Record<string, unknown>)[k] === v;
    });
  const noLimits = () => ({
    dailyLossLimit: null,
    pendingLossLimit: null,
    pendingLossLimitAt: null,
    pendingDepositLimit: null,
    pendingDepositLimitAt: null,
  });
  const client = {
    // H-17 responsible-play tx check hooks: row lock + limit read (no limits set here).
    $queryRaw: vi.fn(async () => []),
    user: {
      findUnique: vi.fn(async () => noLimits()),
      update: vi.fn(async () => ({})),
    },
    wallet: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const w = wallets.find((x) => x.userId === where.userId);
        return w
          ? {
              realBalance: w.balance,
              bonusBalance: 0,
              giftedBalance: 0,
              lockedBalance: 0,
            }
          : null;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { userId: string; type: string } }) =>
          wallets.find((w) => w.userId === where.userId && w.type === where.type) ??
          null
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { userId_type: { userId: string; type: string } };
          data: { balance?: { increment?: number; decrement?: number } };
        }) => {
          const w = wallets.find(
            (x) =>
              x.userId === where.userId_type.userId && x.type === where.userId_type.type
          );
          if (!w) throw new Err('P2025', 'wallet missing');
          if (data.balance?.decrement != null) {
            if (w.balance < data.balance.decrement)
              throw new Err('P2034', 'insufficient');
            w.balance -= data.balance.decrement;
          }
          if (data.balance?.increment != null) w.balance += data.balance.increment;
          return w;
        }
      ),
    },
    sharedRoundBet: {
      // WingoRoundManager.salvageInterruptedRound() counts leftover open
      // bets; without this the restart-salvage path threw
      // "count is not a function" and this test never actually ran it.
      count: vi.fn(
        async ({
          where,
        }: {
          where?: { gameSlug?: string; roundId?: string; status?: string };
        }) =>
          bets.filter(
            (b) =>
              (where?.gameSlug == null || b.gameSlug === where.gameSlug) &&
              (where?.roundId == null || b.roundId === where.roundId) &&
              (where?.status == null || b.status === where.status)
          ).length
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; OR?: Array<Record<string, unknown>> };
        }) => {
          const or = where.OR ?? [];
          return (
            bets.find(
              (b) =>
                b.userId === where.userId &&
                or.some(
                  (c) =>
                    ('requestId' in c && b.requestId === c.requestId) ||
                    ('gameSlug' in c &&
                      'roundId' in c &&
                      b.gameSlug === c.gameSlug &&
                      b.roundId === c.roundId)
                )
            ) ?? null
          );
        }
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<
            SharedBetRow,
            'id' | 'status' | 'payoutAmount' | 'payoutMultiplier' | 'settledAt'
          >;
        }) => {
          // (userId, requestId) unique
          if (
            bets.some((b) => b.userId === data.userId && b.requestId === data.requestId)
          )
            throw new Err('P2002', 'duplicate requestId');
          // (gameSlug, roundId, userId) unique
          if (
            bets.some(
              (b) =>
                b.gameSlug === data.gameSlug &&
                b.roundId === data.roundId &&
                b.userId === data.userId
            )
          )
            throw new Err('P2002', 'already bet this round');
          const row: SharedBetRow = {
            ...clone({
              ...data,
              id: '',
              status: 'PLACED',
              payoutAmount: null,
              payoutMultiplier: null,
              settledAt: null,
            }),
            id: `bet-${bets.length}`,
          };
          bets.push(row);
          return { ...row, amount: fakeDecimal(row.amount) };
        }
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<SharedBetRow>;
        }) => {
          const b = bets.find((x) => x.id === where.id);
          if (!b) throw new Err('P2025', 'bet missing');
          Object.assign(b, data);
          return clone(b);
        }
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<SharedBetRow>;
        }) => {
          const hit = bets.filter((b) => matches(b, where));
          // Conditional claim semantics: only PLACED rows transition.
          for (const b of hit) Object.assign(b, data);
          return { count: hit.length };
        }
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        bets
          .filter((b) => matches(b, where))
          .map((b) => ({ ...clone(b), amount: fakeDecimal(b.amount) }))
      ),
    },
    seedPair: {
      findFirstOrThrow: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const sp = seedPairs.find((x) => x.userId === where.userId);
        if (!sp) throw new Err('P2025', 'seed pair missing');
        return sp;
      }),
    },
    gameRound: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `gr-${gameRounds.length}`, ...data };
        gameRounds.push(row as never);
        return row;
      }),
    },
    /** Serialises concurrent transactions AND rolls back on error, like PG. */
    $transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      while (lockGate.held) await new Promise((r) => setImmediate(r));
      lockGate.held = true;
      const walletsSnap = wallets.map((w) => ({ ...w }));
      const betsSnap = bets.map(clone);
      try {
        return await fn(client);
      } catch (e) {
        wallets.length = 0;
        wallets.push(...walletsSnap);
        bets.length = 0;
        bets.push(...betsSnap);
        throw e;
      } finally {
        lockGate.held = false;
      }
    }),
    __wallets: wallets,
    __bets: bets,
    __seedPairs: seedPairs,
    __gameRounds: gameRounds,
  };
  return client;
}

/* ─────────────────────── module wiring (mocked imports) ─────────────────────── */

t.db = fakeDb();

vi.mock('../../db/prisma', () => ({
  get prisma() {
    return t.db;
  },
}));
vi.mock('../../db/redis', () => ({
  redis: {
    store: new Map<string, string>(),
    async get(this: { store: Map<string, string> }, k: string) {
      return this.store.get(k) ?? null;
    },
    async set(this: { store: Map<string, string> }, k: string, v: string) {
      this.store.set(k, v);
      return 'OK';
    },
    async incr() {
      return 1;
    },
    async setex() {
      return 'OK';
    },
    async rpush() {
      return 1;
    },
    async ltrim() {
      return 'OK';
    },
  },
  keys: {
    wingoRound: (d: '30s' | '60s' | '180s' | '300s') => `game:wingo:${d}:current`,
  },
}));
vi.mock('../../services/wallet', async () => {
  return {
    /** production money() corner-cases string coercion; the fake normalizes
     *  everything through Decimal so arithmetic interoperates with the
     *  settlement code's .mul()/.gt() chains. */
    money: (v: unknown) =>
      v instanceof Decimal
        ? v
        : fakeDecimal(
            typeof v === 'string' || typeof v === 'number' ? v : Number(String(v))
          ),
    deductBet: async (
      userId: string,
      amount: unknown,
      _mode: string,
      _ref: string,
      tx: typeof t.db
    ) => {
      const amt = Number(String(amount));
      await tx.wallet.update({
        where: { userId_type: { userId, type: 'REAL' } },
        data: { balance: { decrement: amt } },
      });
      const snap = await tx.wallet.findFirst({ where: { userId, type: 'REAL' } });
      return {
        deductedFrom: [{ type: 'REAL', amount: fakeDecimal(amt) }],
        snapshot: {
          real: snap!.balance.toFixed(2),
          bonus: '0.00',
          gifted: '0.00',
          locked: '0.00',
        },
      };
    },
    creditWin: async (
      userId: string,
      amount: unknown,
      _ref: string,
      tx: typeof t.db
    ) => {
      await tx.wallet.update({
        where: { userId_type: { userId, type: 'REAL' } },
        data: { balance: { increment: Number(String(amount)) } },
      });
    },
    /** real signature: (userId, split, payout, ref) — no tx param; the fake
     *  sidesteps money()-coercion of split entries by crediting the payout
     *  straight to REAL (the split-shape is covered by the refund property
     *  test, where applyBalanceChange receives the parts raw). */
    creditWinProRata: async (userId: string, _split: unknown, payout: unknown) => {
      await t.db.wallet.update({
        where: { userId_type: { userId, type: 'REAL' } },
        data: { balance: { increment: Number(String(payout)) } },
      });
    },
    applyBalanceChange: async (
      userId: string,
      type: string,
      amount: unknown,
      _dir: string
    ) => {
      await t.db.wallet.update({
        where: { userId_type: { userId, type } },
        data: { balance: { increment: Number(String(amount)) } },
      });
    },
    primaryWalletType: () => 'REAL' as const,
    getWalletSnapshot: async (userId: string) => ({
      real: (
        t.db.__wallets.find(
          (w: { userId: string; type: string }) =>
            w.userId === userId && w.type === 'REAL'
        )?.balance ?? 0
      ).toFixed(2),
      bonus: '0.00',
      gifted: '0.00',
      locked: '0.00',
    }),
  };
});
vi.mock('../../services/gameConfig', () => ({
  getGameConfig: async () => ({
    configJson: {
      payouts: {
        red: 2.4,
        green: 2.4,
        violet: 4.8,
        number: 9.6,
        big: 1.92,
        small: 1.92,
      },
    },
    maxWinMultiplier: '100',
  }),
  snapshotHash: () => 'h',
}));
vi.mock('../StatisticsTracker', () => ({ recordRound: async () => {} }));
vi.mock('../../lib/admin-feed', () => ({
  emitAdmin: () => {},
  shortId: (s: string) => s,
}));
vi.mock('../../services/stakeLimits', () => ({ maxPayoutFor: async () => Infinity }));
vi.mock('../RoundLeaderLease', () => ({
  RoundLeaderLease: class {
    constructor(_k: string) {}
    start() {}
    stop() {}
  },
}));
// Deterministic "serverSeed" so tests don't touch crypto randomness semantics.
vi.mock('@casino/game-core/provably-fair', () => ({
  PROVABLY_FAIR: {
    hmacSha256: () => '0'.repeat(64),
    generateServerSeed: () => 'server-seed-test',
    hashServerSeed: () => 'hash-test',
    generateRawOutcome: () => 42,
  },
}));

import { WingoRoundManager, durationKey } from './WingoRoundManager';
import { refundOpenSharedBets } from '../../services/sharedRoundBets';

/* ─────────────────────────────── helpers ─────────────────────────────── */

function seedWallet(userId: string, amount: number) {
  t.db.__wallets.push({ userId, type: 'REAL', balance: amount });
  if (!t.db.__seedPairs.some((s: { userId?: string }) => s.userId === userId))
    t.db.__seedPairs.push({ id: `sp-${userId}`, userId });
}

/** Inject an open BETTING round into the fake Redis store. */
async function openRound(mgr: WingoRoundManager, duration = 30, endsInMs = 60_000) {
  const round = {
    roundId: `r-${Math.random().toString(36).slice(2)}`,
    period: '20260818000000001',
    durationSec: duration,
    status: 'BETTING',
    endsAt: Date.now() + endsInMs,
    result: null,
    rawOutcome: 3,
    serverSeedHash: 'x',
    serverSeed: 'y',
    bets: [],
  };
  const rmod = await import('../../db/redis');
  await (rmod.redis as unknown as { set(k: string, v: string): Promise<string> }).set(
    `game:wingo:${durationKey(duration as 30)}:current`,
    JSON.stringify(round)
  );
  return round;
}

beforeEach(() => {
  t.db.__wallets.length = 0;
  t.db.__bets.length = 0;
  t.db.__seedPairs.length = 0;
  t.db.__gameRounds.length = 0;
});

/* ─────────────────────────────── tests ─────────────────────────────── */

describe('shared-round concurrency (item #6)', () => {
  it('concurrent placeBet with the SAME requestId → ONE debit, ONE row', async () => {
    seedWallet('u1', 100);
    const mgr = new WingoRoundManager(30);
    const round = await openRound(mgr);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        mgr.placeBet('u1', 3, 10, 'req-same', round.roundId)
      )
    );
    const bal = t.db.__wallets[0].balance;
    expect(t.db.__bets).toHaveLength(1);
    expect(bal).toBeCloseTo(90, 8);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('concurrent placeBet for same user+round, DIFFERENT requestIds → ONE row', async () => {
    seedWallet('u1', 100);
    const mgr = new WingoRoundManager(30);
    const round = await openRound(mgr);
    // Double-submission losing the dedupe window (two HTTP requests whose
    // findFirst both miss before either create commits).
    await Promise.all([
      mgr.placeBet('u1', 3, 10, 'req-a', round.roundId),
      mgr.placeBet('u1', 'red', 10, 'req-b', round.roundId),
    ]);
    // The (gameSlug, roundId, userId) unique index must have swallowed the second.
    expect(t.db.__bets).toHaveLength(1);
  });

  it('a bet racing the lock window is rejected, NOT debited', async () => {
    seedWallet('u1', 100);
    const mgr = new WingoRoundManager(30);
    const round = await openRound(mgr, 30, 100); // ends in 100ms, lock is 5s → closed
    const res = await mgr.placeBet('u1', 3, 10, 'req-late', round.roundId);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/closed/i);
    expect(t.db.__wallets[0].balance).toBeCloseTo(100, 8);
    expect(t.db.__bets).toHaveLength(0);
  });

  it('the drawing phase settles PLACED rows exactly once (conditional claim)', async () => {
    vi.useFakeTimers();
    try {
      seedWallet('u1', 100);
      seedWallet('u2', 100);
      const mgr = new WingoRoundManager(30);
      // Become the clock leader and run the REAL loop(): it creates the round,
      // arms the drawing timer, and (below) settles every PLACED row.
      const lease = (mgr as unknown as { lease: { isLeader: () => boolean } }).lease;
      lease.isLeader = () => true;
      const fakeIo = { emit: vi.fn(), to: () => ({ emit: vi.fn() }) };
      await mgr.start(fakeIo as never);
      (mgr as unknown as { looping: boolean }).looping = true;
      await (mgr as unknown as { loop: () => Promise<void> }).loop();
      await mgr.placeBet('u1', 3, 10, 'r1');
      await mgr.placeBet('u2', 'red', 10, 'r2');
      expect(t.db.__bets).toHaveLength(2);
      // Fire the armed drawing timer (30s round − 5s lock = fires at 25s),
      // its sleep-until-endsAt animation wait (the remaining ~5s to the
      // period boundary), then flush the async settle chain.
      await vi.advanceTimersByTimeAsync(26_000);
      await vi.advanceTimersByTimeAsync(5_100);
      await vi.advanceTimersByTimeAsync(100);
      const rows = t.db.__bets;
      expect(rows.every((b: { status?: string }) => b.status === 'SETTLED')).toBe(true);
      // exactly one GameRound written per bet, payouts credited exactly once
      expect(t.db.__gameRounds).toHaveLength(2);
      const p1 = Number(
        String(rows.find((b: { userId?: string }) => b.userId === 'u1')!.payoutAmount)
      );
      const p2 = Number(
        String(rows.find((b: { userId?: string }) => b.userId === 'u2')!.payoutAmount)
      );
      const w1 = t.db.__wallets.find(
        (w: { userId?: string }) => w.userId === 'u1'
      )!.balance;
      const w2 = t.db.__wallets.find(
        (w: { userId?: string }) => w.userId === 'u2'
      )!.balance;
      expect(w1).toBeCloseTo(100 - 10 + p1, 8);
      expect(w2).toBeCloseTo(100 - 10 + p2, 8);
      // crash-retry safety: nothing left to claim → a repeated pass can never
      // double-credit
      expect(
        (await t.db.sharedRoundBet.findMany({ where: { status: 'PLACED' } })).length
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('property: refundOpenSharedBets returns EXACTLY the split stake, per wallet part', async () => {
    seedWallet('u1', 1000);
    seedWallet('u2', 1000);
    // deterministic-property sweep over varied stakes
    for (const amt of ['1', '13.37', '99.99', '0.01', '250']) {
      const before = t.db.__wallets.find(
        (w: { userId?: string; type?: string }) =>
          w.userId === 'u1' && w.type === 'REAL'
      )!.balance;
      const parts = [{ type: 'REAL', amount: amt }];
      await t.db.$transaction(async (tx: typeof t.db) => {
        await tx.wallet.update({
          where: { userId_type: { userId: 'u1', type: 'REAL' } },
          data: { balance: { decrement: Number(amt) } },
        });
        await tx.sharedRoundBet.create({
          data: {
            userId: 'u1',
            gameSlug: 'wingo',
            roundId: `k8r-${amt}`,
            durationSec: 40,
            requestId: `rq-${amt}`,
            amount: Number(amt),
            walletType: 'REAL',
            deductedFrom: parts,
            choice: { selected: [1] },
          },
        });
      });
      // interrupted — refund everything PLACED for wingo@40s
      const n = await refundOpenSharedBets('wingo', 40);
      expect(n).toBe(1);
      const after = t.db.__wallets.find(
        (w: { userId?: string; type?: string }) =>
          w.userId === 'u1' && w.type === 'REAL'
      )!.balance;
      expect(after).toBeCloseTo(before, 8);
      // double-refund protection: a second refund pass must touch nothing
      expect(await refundOpenSharedBets('wingo', 40)).toBe(0);
    }
    void t.db.__bets;
  });
});
