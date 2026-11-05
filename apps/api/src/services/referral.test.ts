// apps/api/src/services/referral.test.ts
//
// The referral payout is the money path, so it gets the strictest tests in the
// referral work. Two properties matter above all:
//
//   1. it pays EXACTLY ONCE per player (the conditional UPDATE claim), and
//   2. a "should we pay?" check never BURNS that one-shot marker — if the bonus
//      is switched off or capped, the player must still be rewardable later.
//
// `maybeRewardReferral` takes its transaction client as an argument, so the
// fake here is built by hand rather than mocking a whole Prisma client.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';

const SETTINGS: Record<string, unknown> = {
  referral_bonus_enabled: true,
  referral_bonus_referrer: 25,
  referral_bonus_referee: 10,
  referral_max_rewards: 0,
};
vi.mock('./settings', () => ({
  getSettings: async () => SETTINGS,
  getSetting: async (k: string) => SETTINGS[k],
}));

const credits: Array<{
  userId: string;
  walletType: string;
  amount: string;
  type: string;
  referenceId: string;
}> = [];
vi.mock('./wallet', () => ({
  applyBalanceChange: async (
    userId: string,
    walletType: string,
    delta: Decimal,
    type: string,
    reference: { referenceId: string }
  ) => {
    credits.push({
      userId,
      walletType,
      amount: delta.toString(),
      type,
      referenceId: reference.referenceId,
    });
    return {} as never;
  },
}));

vi.mock('../middleware', () => ({
  DEMO_USER_PHONE: () => '+00000000000',
}));

import { maybeRewardReferral } from './referral';

const REFEREE = 'referee-1';
const REFERRER = 'referrer-1';

interface FakeUser {
  id: string;
  phone: string;
  referredById: string | null;
  referralRewardedAt: Date | null;
}

let users: Map<string, FakeUser>;
let claimCount: number; // how many rows updateMany "changed"

function makeTx() {
  return {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const u = users.get(where.id);
        // include the fields the referrer-standing check reads, defaulting to
        // a healthy ACTIVE account (txWithReferrerStatus overrides this)
        return u
          ? {
              id: u.id,
              phone: u.phone,
              referredById: u.referredById,
              status: 'ACTIVE',
              selfExcludedUntil: null,
            }
          : null;
      },
      // The once-only claim. Honours the same predicate the real query uses.
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; referredById: { not: null }; referralRewardedAt: null };
        data: { referralRewardedAt: Date };
      }) => {
        const u = users.get(where.id);
        if (u && u.referredById !== null && u.referralRewardedAt === null) {
          u.referralRewardedAt = data.referralRewardedAt;
          claimCount++;
          return { count: 1 };
        }
        return { count: 0 };
      },
      count: async ({ where }: { where: { referredById: string } }) =>
        [...users.values()].filter(
          (u) => u.referredById === where.referredById && u.referralRewardedAt !== null
        ).length,
    },
  } as never;
}

/** The referral service reads the referrer's standing via a second lookup. */
function txWithReferrerStatus(status: string, selfExcludedUntil: Date | null = null) {
  const base = makeTx() as unknown as {
    user: {
      findUnique: (a: { where: { id: string } }) => Promise<unknown>;
      updateMany: (a: unknown) => Promise<{ count: number }>;
      count: (a: unknown) => Promise<number>;
    };
  };
  const origFind = base.user.findUnique;
  return {
    ...base,
    user: {
      ...base.user,
      findUnique: async (a: { where: { id: string } }) => {
        if (a.where.id === REFERRER) return { status, selfExcludedUntil } as never;
        return origFind(a);
      },
    },
  } as never;
}

function seed(overrides: Partial<FakeUser> = {}) {
  users.set(REFEREE, {
    id: REFEREE,
    phone: '+923001234567',
    referredById: REFERRER,
    referralRewardedAt: null,
    ...overrides,
  });
  users.set(REFERRER, {
    id: REFERRER,
    phone: '+923009999999',
    referredById: null,
    referralRewardedAt: null,
  });
}

beforeEach(() => {
  users = new Map();
  credits.length = 0;
  claimCount = 0;
  SETTINGS.referral_bonus_enabled = true;
  SETTINGS.referral_bonus_referrer = 25;
  SETTINGS.referral_bonus_referee = 10;
  SETTINGS.referral_max_rewards = 0;
});

describe('maybeRewardReferral — the happy path', () => {
  it('pays both legs on the first approved deposit', async () => {
    seed();
    const res = await maybeRewardReferral(makeTx(), REFEREE);
    expect(res.paid).toBe(true);
    expect(credits).toHaveLength(2);

    const refereeLeg = credits.find((c) => c.userId === REFEREE)!;
    const referrerLeg = credits.find((c) => c.userId === REFERRER)!;
    expect(refereeLeg.amount).toBe('10');
    expect(refereeLeg.walletType).toBe('BONUS'); // must be wagered, not withdrawn
    expect(refereeLeg.type).toBe('BONUS_REFERRAL');
    expect(referrerLeg.amount).toBe('25');
    expect(referrerLeg.type).toBe('BONUS_REFERRAL');
    // each leg references the other, so /referral/stats can tie them together
    expect(refereeLeg.referenceId).toBe(REFERRER);
    expect(referrerLeg.referenceId).toBe(REFEREE);
  });

  it('marks the player rewarded exactly once', async () => {
    seed();
    await maybeRewardReferral(makeTx(), REFEREE);
    expect(users.get(REFEREE)!.referralRewardedAt).toBeInstanceOf(Date);
    expect(claimCount).toBe(1);
  });
});

describe('maybeRewardReferral — never pays twice', () => {
  it('a SECOND deposit does not pay again', async () => {
    seed();
    await maybeRewardReferral(makeTx(), REFEREE);
    const afterFirst = credits.length;

    const second = await maybeRewardReferral(makeTx(), REFEREE);
    expect(second.paid).toBe(false);
    expect(second.reason).toBe('already-rewarded');
    expect(credits).toHaveLength(afterFirst);
  });

  it('two CONCURRENT approvals credit only one of them', async () => {
    seed();
    // Both run against the same fake store; the conditional UPDATE means only
    // the first can win the claim.
    const [a, b] = await Promise.all([
      maybeRewardReferral(makeTx(), REFEREE),
      maybeRewardReferral(makeTx(), REFEREE),
    ]);
    expect([a.paid, b.paid].filter(Boolean)).toHaveLength(1);
    expect(credits).toHaveLength(2); // one payout = two legs, not four
  });

  it('a player nobody referred is never paid', async () => {
    seed({ referredById: null });
    const res = await maybeRewardReferral(makeTx(), REFEREE);
    expect(res).toEqual({ paid: false, reason: 'not-referred' });
    expect(credits).toHaveLength(0);
  });
});

describe('maybeRewardReferral — the checks run BEFORE the claim', () => {
  it('switched off: no payout AND the one-shot marker is NOT burned', async () => {
    seed();
    SETTINGS.referral_bonus_enabled = false;
    const res = await maybeRewardReferral(makeTx(), REFEREE);
    expect(res).toEqual({ paid: false, reason: 'disabled' });
    expect(credits).toHaveLength(0);
    expect(users.get(REFEREE)!.referralRewardedAt).toBeNull(); // still rewardable
    expect(claimCount).toBe(0);
  });

  it('capped: no payout and the marker is NOT burned', async () => {
    seed();
    SETTINGS.referral_max_rewards = 1;
    // one already-paid referee for the same referrer
    users.set('other', {
      id: 'other',
      phone: '+923000000001',
      referredById: REFERRER,
      referralRewardedAt: new Date(),
    });
    const res = await maybeRewardReferral(makeTx(), REFEREE);
    expect(res).toEqual({ paid: false, reason: 'capped' });
    expect(credits).toHaveLength(0);
    expect(users.get(REFEREE)!.referralRewardedAt).toBeNull();
  });

  it('zero amounts: no payout, marker not burned', async () => {
    seed();
    SETTINGS.referral_bonus_referrer = 0;
    SETTINGS.referral_bonus_referee = 0;
    const res = await maybeRewardReferral(makeTx(), REFEREE);
    expect(res).toEqual({ paid: false, reason: 'zero-amount' });
    expect(users.get(REFEREE)!.referralRewardedAt).toBeNull();
  });
});

describe('maybeRewardReferral — protecting the house', () => {
  it('never pays the shared demo account', async () => {
    seed({ phone: '+00000000000' });
    const res = await maybeRewardReferral(makeTx(), REFEREE);
    expect(res).toEqual({ paid: false, reason: 'demo-user' });
    expect(credits).toHaveLength(0);
  });

  for (const status of ['SUSPENDED', 'CLOSED', 'SELF_EXCLUDED']) {
    it(`does not pay a ${status} referrer`, async () => {
      seed();
      const res = await maybeRewardReferral(txWithReferrerStatus(status), REFEREE);
      expect(res).toEqual({ paid: false, reason: 'referrer-inactive' });
      expect(credits).toHaveLength(0);
      expect(users.get(REFEREE)!.referralRewardedAt).toBeNull();
    });
  }

  it('does not pay a referrer inside an active self-exclusion window', async () => {
    seed();
    const future = new Date(Date.now() + 86_400_000);
    const res = await maybeRewardReferral(
      txWithReferrerStatus('ACTIVE', future),
      REFEREE
    );
    expect(res.reason).toBe('referrer-inactive');
    expect(credits).toHaveLength(0);
  });

  it('pays each leg independently when the other is zero', async () => {
    seed();
    SETTINGS.referral_bonus_referee = 0; // only the referrer leg
    const res = await maybeRewardReferral(makeTx(), REFEREE);
    expect(res.paid).toBe(true);
    expect(credits).toHaveLength(1);
    expect(credits[0]!.userId).toBe(REFERRER);
  });
});

describe('maybeRewardReferral — never breaks a deposit', () => {
  it('swallows an unexpected error instead of rolling back the approval', async () => {
    seed();
    const brokenTx = {
      user: {
        findUnique: async () => {
          throw new Error('db exploded');
        },
        updateMany: async () => ({ count: 0 }),
        count: async () => 0,
      },
    } as never;
    await expect(maybeRewardReferral(brokenTx, REFEREE)).resolves.toEqual({
      paid: false,
    });
  });
});
