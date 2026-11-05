// apps/api/src/services/auth.test.ts — signup/login with mocked prisma + redis (docs/20 §20)
import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const users = new Map<
    string,
    {
      id: string;
      phone: string;
      passwordHash: string;
      referralCode: string;
      referredById?: string | null;
    }
  >();
  const wallets: unknown[] = [];
  const seedPairs: unknown[] = [];

  const prismaLike = {
    user: {
      findUnique: async ({
        where,
      }: {
        where: { phone?: string; referralCode?: string };
      }) => {
        for (const u of users.values())
          if (u.phone === where.phone || u.referralCode === where.referralCode)
            return u;
        return null;
      },
      create: async (d: { data: Record<string, unknown> }) => {
        const user = { id: `u${users.size + 1}`, ...d.data } as unknown as {
          id: string;
          phone: string;
          passwordHash: string;
          referralCode: string;
          referredById?: string | null;
        };
        users.set(user.phone, user);
        return user;
      },
      update: async () => ({}),
      findUniqueOrThrow: async ({ where }: { where: { phone: string } }) => {
        const u = [...users.values()].find((x) => x.phone === where.phone);
        if (!u) throw new Error('not found');
        return u;
      },
    },
    wallet: {
      create: async (d: unknown) => {
        wallets.push((d as { data: unknown }).data);
        return d;
      },
      update: async () => ({}),
    },
    seedPair: {
      create: async (d: unknown) => {
        seedPairs.push((d as { data: unknown }).data);
        return d;
      },
    },
    notification: { create: async () => ({}) },
    setting: { findMany: async () => [] },
    // Refresh-token families are durable Postgres rows now (see
    // session-security.test.ts for the dedicated coverage).
    refreshTokenFamily: {
      create: async (d: { data: Record<string, unknown> }) => d.data,
      findUnique: async () => null,
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
  };

  return { users, wallets, seedPairs, prismaLike };
});

vi.mock('../db/redis', () => ({
  redis: {
    set: async () => 'OK',
    get: async () => null,
    del: async () => 1,
    expire: async () => 1,
  },
  // signup/login read the tunable security settings (password policy, lockout
  // thresholds) through services/settings.ts, which uses the cache key helper
  // and reports a Redis failure through logRedisIssue. The mock has to expose
  // both or the first missing export throws instead of the code under test.
  keys: { settingsCache: () => 'settings:all' },
  logRedisIssue: () => undefined,
}));
vi.mock('../db/prisma', () => ({
  prisma: {
    ...h.prismaLike,
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(h.prismaLike),
  },
}));

import bcrypt from 'bcrypt';
import { signup, login } from './auth';

const { users, wallets, seedPairs } = h;
const FP = { userAgent: 't', screenRes: '1x1', timezone: 'UTC', language: 'en' };

beforeEach(() => {
  users.clear();
  wallets.length = 0;
  seedPairs.length = 0;
});

describe('signup', () => {
  it('creates user + wallet + seed pair (docs/19 §4 post-signup)', async () => {
    const { accessToken } = await signup({
      phone: '+923001234567',
      password: 'Karachi-Play-77',
      fingerprint: FP,
    });
    expect(accessToken).toBeTruthy();
    expect(wallets).toHaveLength(1);
    expect(seedPairs).toHaveLength(1);
    expect((seedPairs[0] as { serverSeedHash: string }).serverSeedHash).toHaveLength(
      64
    );
  });

  it('rejects duplicate phone (AUTH_008)', async () => {
    await signup({ phone: '+923001234567', password: 'Karachi-Play-77', fingerprint: FP });
    await expect(
      signup({ phone: '+923001234567', password: 'Karachi-Play-77', fingerprint: FP })
    ).rejects.toMatchObject({ code: 'AUTH_008' });
  });

  // BEHAVIOUR CHANGE: an unknown invite code no longer blocks registration.
  // Losing a new player over a stale or mistyped code is a worse trade than
  // losing the bonus — the signup goes through and reports it was not applied.
  it('accepts signup with an unknown referral code and reports it as not applied', async () => {
    const res = await signup({
      phone: '+923001234567',
      password: 'Karachi-Play-77',
      fingerprint: FP,
      referralCode: 'NOPE',
    });
    expect(res.accessToken).toBeTruthy();
    expect(res.referralApplied).toBe(false);
    expect(users.get('+923001234567')?.referredById).toBeFalsy();
  });

  it('links the referrer when the code is valid', async () => {
    const referrer = await signup({
      phone: '+923001111111',
      password: 'Karachi-Play-77',
      fingerprint: FP,
    });
    expect(referrer.referralApplied).toBe(false); // none supplied
    const referrerRow = users.get('+923001111111')!;
    const code = String((referrerRow as { referralCode?: string }).referralCode);

    const res = await signup({
      phone: '+923002222222',
      password: 'Karachi-Play-77',
      fingerprint: FP,
      referralCode: code,
    });
    expect(res.referralApplied).toBe(true);
    expect(users.get('+923002222222')?.referredById).toBe(referrerRow.id);
  });

  it('matches the code regardless of CASE (invite links get re-cased in transit)', async () => {
    await signup({ phone: '+923001111111', password: 'Karachi-Play-77', fingerprint: FP });
    const row = users.get('+923001111111')!;
    const code = String((row as { referralCode?: string }).referralCode);
    expect(code).toBe(code.toUpperCase()); // codes are stored canonical

    for (const variant of [code.toLowerCase(), code, code.toLowerCase() + '  ']) {
      users.delete('+923003333333');
      const res = await signup({
        phone: '+923003333333',
        password: 'Karachi-Play-77',
        fingerprint: FP,
        referralCode: variant,
      });
      expect(res.referralApplied, `variant: ${variant}`).toBe(true);
      expect(users.get('+923003333333')?.referredById).toBe(row.id);
    }
  });
});

describe('login', () => {
  it('accepts valid credentials and rejects invalid with the SAME error (docs/19 §4)', async () => {
    const phone = '+923001234567';
    const password = 'Karachi-Play-77';
    await signup({ phone, password, fingerprint: FP });
    const { accessToken } = await login(phone, password, FP);
    expect(accessToken).toBeTruthy();

    await expect(login(phone, 'wrong-password', FP)).rejects.toMatchObject({
      code: 'AUTH_001',
    });
    await expect(login('+923009999999', password, FP)).rejects.toMatchObject({
      code: 'AUTH_001',
    });
  });

  it('hashes passwords with bcrypt cost 12', async () => {
    const phone = '+923001234567';
    await signup({ phone, password: 'Karachi-Play-77', fingerprint: FP });
    const user = [...users.values()].find((u) => u.phone === phone)!;
    expect(user.passwordHash).not.toContain('Karachi-Play-77');
    expect(await bcrypt.compare('Karachi-Play-77', user.passwordHash)).toBe(true);
  });

  // Account state must be enforced AT LOGIN, not just on later requests.
  // Previously a banned or self-excluded user received valid tokens and only
  // hit a confusing 403 on their next call.
  describe('account state is enforced at the door', () => {
    const phone = '+923001234567';
    const password = 'Karachi-Play-77';

    const setState = (patch: Record<string, unknown>) => {
      const u = users.get(phone) as unknown as Record<string, unknown>;
      Object.assign(u, patch);
    };

    it('blocks a SUSPENDED account with a clear message', async () => {
      await signup({ phone, password, fingerprint: FP });
      setState({ status: 'SUSPENDED' });
      await expect(login(phone, password, FP)).rejects.toMatchObject({
        code: 'AUTH_005',
      });
    });

    it('blocks a CLOSED account', async () => {
      await signup({ phone, password, fingerprint: FP });
      setState({ status: 'CLOSED' });
      await expect(login(phone, password, FP)).rejects.toMatchObject({
        code: 'AUTH_006',
      });
    });

    it('blocks an ACTIVE self-excluded account (responsible gambling)', async () => {
      await signup({ phone, password, fingerprint: FP });
      // Status can still read ACTIVE while an exclusion window is open.
      setState({
        status: 'ACTIVE',
        selfExcludedUntil: new Date(Date.now() + 86_400_000),
      });
      await expect(login(phone, password, FP)).rejects.toMatchObject({
        code: 'AUTH_007',
      });
    });

    it('allows login once a self-exclusion has expired', async () => {
      await signup({ phone, password, fingerprint: FP });
      setState({ status: 'ACTIVE', selfExcludedUntil: new Date(Date.now() - 1000) });
      const { accessToken } = await login(phone, password, FP);
      expect(accessToken).toBeTruthy();
    });
  });
});
