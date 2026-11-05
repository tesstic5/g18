import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoundLeaderLease } from './RoundLeaderLease';

/**
 * Regression coverage for the transient-Redis-flap fix: a single failed
 * renewal (docker DNS hiccup / EAI_AGAIN burst) must NOT pause the shared
 * game clock. Leadership is only surrendered after `maxConsecutiveErrors`
 * failed ticks in a row, or when the key was genuinely lost (renew → 0).
 */

const t = {
  evalImpl: async (..._args: unknown[]): Promise<number> => 1,
  setImpl: async (..._args: unknown[]): Promise<string | null> => 'OK',
};

vi.mock('../db/redis', () => ({
  redis: {
    eval: (...args: unknown[]) => t.evalImpl(...args),
    set: (...args: unknown[]) => t.setImpl(...args),
  },
}));

const tick = () => new Promise((r) => setTimeout(r, 25));
/** Wait until `cond` is true (poll every 5ms, 1s cap) — avoids brittle tick counting. */
const until = async (cond: () => boolean) => {
  const deadline = Date.now() + 1000;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error('until() timed out');
};

describe('RoundLeaderLease transient error tolerance', () => {
  beforeEach(() => {
    t.evalImpl = async () => 1;
    t.setImpl = async () => 'OK';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps leadership through a single transient renewal error', async () => {
    const gained: string[] = [];
    const lost: string[] = [];
    const lease = new RoundLeaderLease('test:lease:a', 60, 10, 3);
    let calls = 0;
    t.evalImpl = async () => {
      calls += 1;
      if (calls === 2) throw new Error('getaddrinfo EAI_AGAIN redis');
      return 1;
    };
    lease.start(
      () => gained.push('g'),
      () => lost.push('l')
    );
    await until(() => gained.length === 1); // acquired
    await until(() => calls >= 3); // passed the failing renew + recovery
    await tick();
    expect(lost.length).toBe(0); // never surrendered on one blip
    expect(lease.isLeader()).toBe(true);
    expect(gained.length).toBe(1); // no spurious re-elect
    await lease.stop(() => undefined);
  });

  it('surrenders after maxConsecutiveErrors consecutive failures, then re-elects on recovery', async () => {
    const gained: string[] = [];
    const lost: string[] = [];
    const lease = new RoundLeaderLease('test:lease:b', 60, 10, 3);
    let failing = false;
    t.evalImpl = async () => {
      if (failing) throw new Error('redis unreachable');
      return 1;
    };
    t.setImpl = async () => (failing ? null : 'OK');
    lease.start(
      () => gained.push('g'),
      () => lost.push('l')
    );
    await until(() => lease.isLeader());
    failing = true;
    // 3 consecutive failed ticks → surrender (only then)
    await until(() => lost.length === 1);
    expect(lease.isLeader()).toBe(false);
    // Redis comes back → re-acquire and resume the clock
    failing = false;
    await until(() => gained.length === 2 && lease.isLeader());
    await lease.stop(() => undefined);
  });

  it('surrenders immediately on genuine key loss (renew returns 0)', async () => {
    const lost: string[] = [];
    const lease = new RoundLeaderLease('test:lease:c', 60, 10, 3);
    let calls = 0;
    t.evalImpl = async () => {
      calls += 1;
      return calls === 1 ? 1 : 0; // second renew: key already stolen/expired
    };
    // Allow the initial acquire; afterwards another process holds the key.
    let acquiredOnce = false;
    t.setImpl = async () => (acquiredOnce ? null : ((acquiredOnce = true), 'OK'));
    lease.start(
      () => undefined,
      () => lost.push('l')
    );
    await until(() => lease.isLeader()); // acquire + renew ok
    await until(() => lost.length === 1); // renew → 0 → immediate surrender
    expect(lease.isLeader()).toBe(false);
    await lease.stop(() => undefined);
  });
});
