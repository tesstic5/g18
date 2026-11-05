// Restart / two-replica invariants for house-clock games.
//
// Production gate: Redis restart, API restart, and two replicas must not
// lose or double-settle a stake. These tests use an in-memory Redis stand-in
// so they run in unit CI; the real stack is exercised by scripts/integration.sh.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoundLeaderLease } from '../RoundLeaderLease';
import { crashSalvageKind } from './crash-salvage';
import { CRASH_TAXI_MS } from './AviatorGame';

const t = {
  evalImpl: async (..._args: unknown[]): Promise<number> => 1,
  setImpl: async (..._args: unknown[]): Promise<string | null> => 'OK',
};

vi.mock('../../db/redis', () => ({
  redis: {
    eval: (...args: unknown[]) => t.evalImpl(...args),
    set: (...args: unknown[]) => t.setImpl(...args),
  },
}));

const until = async (cond: () => boolean, ms = 1500) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error('until() timed out');
};

describe('two-replica leader election', () => {
  beforeEach(() => {
    t.evalImpl = async () => 1;
    t.setImpl = async () => 'OK';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exactly one replica holds the lease when two compete (SET NX)', async () => {
    const store = new Map<string, string>();
    t.setImpl = async (key: unknown, token: unknown, ...rest: unknown[]) => {
      const nx = rest.includes('NX');
      if (nx && store.has(String(key))) return null;
      store.set(String(key), String(token));
      return 'OK';
    };
    t.evalImpl = async (_script: unknown, _n: unknown, key: unknown, token: unknown) =>
      store.get(String(key)) === String(token) ? 1 : 0;

    const a = new RoundLeaderLease('leader:round:crash', 200, 20, 3);
    const b = new RoundLeaderLease('leader:round:crash', 200, 20, 3);
    const gained: string[] = [];
    a.start(
      () => gained.push('a'),
      () => undefined
    );
    b.start(
      () => gained.push('b'),
      () => undefined
    );
    await until(() => gained.length === 1);
    await new Promise((r) => setTimeout(r, 60));
    expect(gained).toHaveLength(1);
    expect(a.isLeader() !== b.isLeader()).toBe(true);
    await a.stop(() => undefined);
    await b.stop(() => undefined);
  });

  it('standby takes over after the owner releases (API restart)', async () => {
    const store = new Map<string, string>();
    t.setImpl = async (key: unknown, token: unknown, ...rest: unknown[]) => {
      if (rest.includes('NX') && store.has(String(key))) return null;
      store.set(String(key), String(token));
      return 'OK';
    };
    t.evalImpl = async (script: unknown, _n: unknown, key: unknown, token: unknown) => {
      const s = String(script);
      if (s.includes('del')) {
        if (store.get(String(key)) === String(token)) {
          store.delete(String(key));
          return 1;
        }
        return 0;
      }
      return store.get(String(key)) === String(token) ? 1 : 0;
    };

    const a = new RoundLeaderLease('leader:round:wingo', 200, 20, 3);
    const b = new RoundLeaderLease('leader:round:wingo', 200, 20, 3);
    a.start(
      () => undefined,
      () => undefined
    );
    b.start(
      () => undefined,
      () => undefined
    );
    await until(() => a.isLeader() || b.isLeader());
    const first = a.isLeader() ? a : b;
    const standby = a.isLeader() ? b : a;
    expect(standby.isLeader()).toBe(false);
    await first.stop(() => undefined);
    await until(() => standby.isLeader());
    expect(standby.isLeader()).toBe(true);
    await standby.stop(() => undefined);
  });
});

describe('crash API-restart salvage order', () => {
  const cfg = { configJson: { growth_rate: 0.00016 } };

  it('settles a leftover CRASHED round instead of refunding winners', () => {
    expect(
      crashSalvageKind({
        status: 'CRASHED',
        startedAt: Date.now() - 8_000,
        crashedAt: Date.now() - 50,
        crashPoint: 2.1,
        config: cfg,
      })
    ).toBe('settle');
  });

  it('resumes a still-flying round after the process restarts', () => {
    expect(
      crashSalvageKind(
        {
          status: 'FLYING',
          startedAt: Date.now() - 200,
          crashedAt: null,
          crashPoint: 12,
          config: cfg,
        },
        Date.now()
      )
    ).toBe('resume');
  });

  it('refunds only rounds that never took off (WAITING/BETTING)', () => {
    expect(
      crashSalvageKind({
        status: 'BETTING',
        startedAt: null,
        crashedAt: null,
        crashPoint: 3,
        config: cfg,
      })
    ).toBe('refund');
  });

  it('treats a FLYING round past its crash point as settle (clock jumped over taxi)', () => {
    expect(
      crashSalvageKind(
        {
          status: 'FLYING',
          startedAt: 0,
          crashedAt: null,
          crashPoint: 0.5,
          config: cfg,
        },
        CRASH_TAXI_MS + 50
      )
    ).toBe('settle');
  });
});
