// apps/api/src/integration/flows.test.ts — REAL end-to-end flows via Fastify app.inject().
// Requires Postgres + Redis (see scripts/integration.sh). Auto-skips when unreachable.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../server';
import { redis, keys } from '../db/redis';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { prisma } from '../db/prisma';
import Decimal from 'decimal.js';
import { applyBalanceChange } from '../services/wallet';

let app: FastifyInstance;
let io: Server | null = null;

// Probe the real stack at module scope (top-level await) — describe.skip is
// evaluated at collection time, so the probe CANNOT live in beforeAll.
let available = false;
try {
  // All inject() calls share the 127.0.0.1 IP → clear rate-limit counters so
  // the auth tests don't contaminate later suites. This MUST live inside the
  // probe's try/catch: at module top level an unreachable Redis threw
  // ("Stream isn't writeable") before the guard, so the suite failed hard
  // instead of skipping as the header comment promises.
  await redis.del(keys.rl('signup', '127.0.0.1'));
  await redis.del(keys.rl('login', '127.0.0.1'));

  app = await buildServer();
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/health' });
  const body = res.json() as { status: string };
  console.error('[integration] health:', res.statusCode, JSON.stringify(body));
  if (body.status === 'ok') {
    available = true;
    const { Server } = await import('socket.io');
    io = new Server(app.server, { transports: ['websocket'], pingTimeout: 30000 });
    (globalThis as { __io?: Server }).__io = io;
    const { initializeSocketServer } = await import('../socket/SocketServer');
    initializeSocketServer(io);
  }
} catch (e) {
  available = false;
  console.error('[integration] probe failed:', (e as Error).message);
}

if (
  !available &&
  (process.env.INTEGRATION_REQUIRED === '1' ||
    process.env.INTEGRATION_REQUIRED === 'true')
) {
  throw new Error(
    '[integration] Postgres/Redis stack is required (INTEGRATION_REQUIRED=1) but was unreachable. Refusing to skip.'
  );
}

// ── Test-data cleanup ──────────────────────────────────────────────────────
// Every describe below signs up (or creates) a real user with real ledger
// rows. Without a matching teardown each run leaves users, deposits,
// transactions and game rounds behind, so the database grows monotonically and
// admin-facing counts/reconciliation drift away from a clean install.
//
// Only identities THIS FILE registered are ever removed, and only against a
// local database — the cleanup is destructive, so it refuses to run anywhere
// else.
const trackedPhones = new Set<string>();
const trackedUserIds = new Set<string>();

// NOTE: DATABASE_URL is NOT in process.env here — Prisma loads .env inside
// its own config, so an env-var check here would silently always refuse. Ask
// the server itself where it lives instead.
async function isLocalDatabase(): Promise<boolean> {
  try {
    const [row] = await prisma.$queryRaw<Array<{ addr: string | null }>>`
      SELECT inet_server_addr()::text AS addr
    `;
    const addr = row?.addr ?? '';
    // loopback, or a private-range LAN address (docker-compose network)
    return (
      addr === '' ||
      addr.startsWith('127.') ||
      addr === '::1' ||
      /^10\./.test(addr) ||
      /^192\.168\./.test(addr) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(addr)
    );
  } catch {
    return false; // cannot confirm → do not delete anything
  }
}

/**
 * Delete a user and every row that hangs off it.
 *
 * Most user foreign keys are RESTRICT (Wallet, GameRound, Deposit, SeedPair,
 * Transaction…), so the dependents have to be removed first — deleting the
 * user row on its own throws. Order below is children-before-parents.
 */
async function deleteTrackedUsers(): Promise<void> {
  if (!(await isLocalDatabase())) {
    console.error('[integration] refusing to delete test data: non-local DATABASE_URL');
    return;
  }
  const ids = new Set(trackedUserIds);
  for (const phone of trackedPhones) {
    const found = await prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (found) ids.add(found.id);
  }
  for (const userId of ids) {
    await prisma.$transaction([
      prisma.notificationRead.deleteMany({ where: { userId } }),
      prisma.supportMessage.deleteMany({ where: { userId } }),
      prisma.transaction.deleteMany({ where: { userId } }),
      prisma.dailyCheckin.deleteMany({ where: { userId } }),
      prisma.deposit.deleteMany({ where: { userId } }),
      prisma.withdrawal.deleteMany({ where: { userId } }),
      prisma.fraudSignal.deleteMany({ where: { userId } }),
      prisma.gameRound.deleteMany({ where: { userId } }),
      prisma.leaderboardEntry.deleteMany({ where: { userId } }),
      prisma.payoutAccount.deleteMany({ where: { userId } }),
      prisma.seedPair.deleteMany({ where: { userId } }),
      prisma.sharedRoundBet.deleteMany({ where: { userId } }),
      prisma.supportConversation.deleteMany({ where: { userId } }),
      prisma.giftTransaction.deleteMany({ where: { senderId: userId } }),
      prisma.winStreak.deleteMany({ where: { userId } }),
      prisma.notification.deleteMany({ where: { userId } }),
      prisma.wallet.deleteMany({ where: { userId } }),
      prisma.user.delete({ where: { id: userId } }),
    ]);
  }
  if (ids.size) console.error(`[integration] cleaned up ${ids.size} test user(s)`);
}

afterAll(async () => {
  if (io) io.close();
  if (app) await app.close();
  // File-scoped afterAll runs LAST (after every describe's own afterAll), so
  // by here the sub-suites have already restored their config/env.
  await deleteTrackedUsers();
});

const skip = available ? describe : describe.skip;

skip('auth flow', () => {
  const phone = `+92${String(Math.floor(3000000000 + Math.random() * 999999999))}`;
  trackedPhones.add(phone);
  let access = '';

  it('signup → login → me', async () => {
    const fp = { userAgent: 'test', screenRes: '1x1', timezone: 'UTC', language: 'en' };
    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { phone, password: 'Karachi-Play-77', fingerprint: fp },
    });
    expect(signup.statusCode).toBe(200);
    access = (signup.json() as { data: { accessToken: string } }).data.accessToken;
    expect(access).toBeTruthy();

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { data: { phone: string } }).data.phone).toBe(phone);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone, password: 'Karachi-Play-77', fingerprint: fp },
    });
    expect(login.statusCode).toBe(200);
  });

  it('rejects duplicate phone', async () => {
    const fp = { userAgent: 'test', screenRes: '1x1', timezone: 'UTC', language: 'en' };
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { phone, password: 'Karachi-Play-77', fingerprint: fp },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rate-limits login (20/15min → 429)', async () => {
    const fp = { userAgent: 'test', screenRes: '1x1', timezone: 'UTC', language: 'en' };
    let last = 200;
    // D-103: limit raised 5 → 20 per 15 min (a 5-cap locked out real users);
    // 22 attempts must still trip it.
    for (let i = 0; i < 22; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { phone: '+92999999999', password: 'wrong', fingerprint: fp },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

skip('bet flow (dice)', () => {
  let access = '';
  let clientSeed = '';
  const phone = `+92${String(Math.floor(3000000000 + Math.random() * 999999999))}`;

  beforeAll(async () => {
    // previous suites exhausted the shared-IP rate-limit buckets — reset them
    await redis.del(keys.rl('signup', '127.0.0.1'));
    await redis.del(keys.rl('login', '127.0.0.1'));
    const fp = { userAgent: 'test', screenRes: '1x1', timezone: 'UTC', language: 'en' };
    const s = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { phone, password: 'Karachi-Play-77', fingerprint: fp },
    });
    access = (s.json() as { data: { accessToken: string } }).data.accessToken;
    // fetch the real client seed (engine rejects mismatched seeds)
    const seedRes = await app.inject({
      method: 'GET',
      url: '/api/v1/provably-fair/active-seed',
      headers: { authorization: `Bearer ${access}` },
    });
    clientSeed = (seedRes.json() as { data: { clientSeed: string } }).data.clientSeed;
    // fund the player via admin fund
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/panel/auth/login',
      payload: {
        username: 'superadmin',
        password: process.env.ADMIN_DEFAULT_PASSWORD || 'change-this-immediately',
      },
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminCookie = adminLogin.cookies.find((c) => c.name === 'admin_token')?.value;
    const csrfCookie = adminLogin.cookies.find((c) => c.name === 'csrf_token')?.value;
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${access}` },
    });
    const userId = (me.json() as { data: { id: string } }).data.id;
    trackedUserIds.add(userId);
    const fund = await app.inject({
      method: 'POST',
      url: `/api/v1/panel/users/${userId}/fund`,
      payload: { walletType: 'real', amount: 1000 },
      headers: {
        cookie: `admin_token=${adminCookie}; csrf_token=${csrfCookie}`,
        'x-csrf-token': csrfCookie ?? '',
      },
    });
    expect(fund.statusCode).toBe(200);
  });

  it('places a dice bet and settles atomically', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/balance',
      headers: { authorization: `Bearer ${access}` },
    });
    const balBefore = Number((before.json() as { data: { real: string } }).data.real);

    const bet = await app.inject({
      method: 'POST',
      url: '/api/v1/games/dice/bet',
      headers: { authorization: `Bearer ${access}` },
      payload: { amount: 10, choices: { over: true, target: 50 }, clientSeed },
    });
    expect(bet.statusCode).toBe(200);
    const body = bet.json() as {
      data: {
        roundId: string;
        result: string;
        payoutAmount: number;
        newBalance: { real: number };
      };
    };
    expect(body.data.roundId).toBeTruthy();
    expect(['WIN', 'LOSE', 'CASHOUT', 'BUST']).toContain(body.data.result);
    // balance = before - 10 + payout (rounded)
    expect(body.data.newBalance.real).toBeCloseTo(
      balBefore - 10 + body.data.payoutAmount,
      2
    );
  });

  it('rejects a bet above balance (422)', async () => {
    // Must be INSIDE the stake window, otherwise the H-1 max-bet rule rejects
    // it first with a 400 and this stops testing the balance path at all.
    // 400,000 is under the 500,000 default ceiling and far above the test
    // wallet, so "insufficient balance" is genuinely the first failure.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/games/dice/bet',
      headers: { authorization: `Bearer ${access}` },
      payload: {
        amount: 400000,
        choices: { target: 50, over: true },
        clientSeed,
      },
    });
    // 422, not 402: some proxies/CDNs treat 402 Payment Required specially and
    // the web client only special-cases 401/408, so an insufficient-balance
    // 402 fell through to a generic error toast.
    expect(res.statusCode).toBe(422);
  });

  it('rejects a stake above the maximum (H-1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/games/dice/bet',
      headers: { authorization: `Bearer ${access}` },
      payload: {
        amount: 99999999,
        choices: { target: 50, over: true },
        clientSeed,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/Maximum bet/i);
  });

  it('rejects a stake below the minimum (H-1)', async () => {
    // minBet was enforced NOWHERE: R0.01 bets were legal, which made
    // flat-amount streak/rakeback bonuses farmable with dust.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/games/dice/bet',
      headers: { authorization: `Bearer ${access}` },
      payload: { amount: 0.01, choices: { target: 50, over: true }, clientSeed },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/Minimum bet/i);
  });

  it('rejects a malformed roulette split (C-1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/games/roulette/bet',
      headers: { authorization: `Bearer ${access}` },
      payload: {
        amount: 10,
        clientSeed,
        choices: {
          bet: { type: 'split', numbers: Array.from({ length: 37 }, (_, i) => i) },
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects duplicate keno picks (C-2)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/games/keno/bet',
      headers: { authorization: `Bearer ${access}` },
      payload: { amount: 10, clientSeed, choices: { picks: Array(10).fill(1) } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a negative stake (C-3)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/games/dice/bet',
      headers: { authorization: `Bearer ${access}` },
      payload: {
        amount: -1000,
        choices: { target: 50, over: true },
        clientSeed,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('is idempotent on duplicate requestId', async () => {
    const requestId = crypto.randomUUID();
    const bet = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/games/dice/bet',
        headers: { authorization: `Bearer ${access}` },
        // 10, not 5: the platform minimum stake is now 10 (global_min_bet), so a
        // 5 bet is correctly rejected and this would stop testing idempotency.
        payload: {
          amount: 10,
          choices: { over: true, target: 50 },
          clientSeed,
          requestId,
        },
      });
    const a = await bet();
    const b = await bet();
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect((a.json() as { data: { roundId: string } }).data.roundId).toBe(
      (b.json() as { data: { roundId: string } }).data.roundId
    );
  });
});

skip('financial transition concurrency', () => {
  it('credits a deposit exactly once under concurrent approvals', async () => {
    const phone = `+92${String(Math.floor(5000000000 + Math.random() * 999999999))}`;
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'integration-only',
        referralCode: crypto.randomUUID(),
      },
    });
    trackedUserIds.add(user.id);
    await prisma.wallet.create({ data: { userId: user.id } });
    const deposit = await prisma.deposit.create({
      data: {
        userId: user.id,
        amount: '100',
        paymentMethod: 'integration',
        referenceNumber: `CONC-${crypto.randomUUID()}`,
      },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/panel/auth/login',
      payload: {
        username: 'superadmin',
        password: process.env.ADMIN_DEFAULT_PASSWORD || 'change-this-immediately',
      },
    });
    // Assert the login: a wrong/absent super-admin password must fail HERE,
    // not later as an unexplained 403 on the review call.
    expect(login.statusCode, login.body).toBe(200);
    const adminCookie = login.cookies.find(
      (cookie) => cookie.name === 'admin_token'
    )?.value;
    const csrf =
      login.cookies.find((cookie) => cookie.name === 'csrf_token')?.value ?? '';
    const approve = () =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/panel/deposits/${deposit.id}`,
        payload: { status: 'APPROVED' },
        headers: {
          cookie: `admin_token=${adminCookie}; csrf_token=${csrf}`,
          'x-csrf-token': csrf,
        },
      });
    const responses = await Promise.all([approve(), approve()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(wallet.realBalance.toString()).toBe('100');
    expect(
      await prisma.transaction.count({
        where: { userId: user.id, type: 'DEPOSIT', referenceId: deposit.id },
      })
    ).toBe(1);
  });
});

skip('finance review validation', () => {
  it('rejects deposit review with an unlisted status (422, stays PENDING)', async () => {
    const phone = `+92${String(Math.floor(6000000000 + Math.random() * 99999999))}`;
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'integration-only',
        referralCode: crypto.randomUUID(),
      },
    });
    trackedUserIds.add(user.id);
    await prisma.wallet.create({ data: { userId: user.id } });
    const deposit = await prisma.deposit.create({
      data: {
        userId: user.id,
        amount: '250',
        paymentMethod: 'integration',
        referenceNumber: `VAL-${crypto.randomUUID()}`,
      },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/panel/auth/login',
      payload: {
        username: 'superadmin',
        password: process.env.ADMIN_DEFAULT_PASSWORD || 'change-this-immediately',
      },
    });
    // Assert the login: a wrong/absent super-admin password must fail HERE,
    // not later as an unexplained 403 on the review call.
    expect(login.statusCode, login.body).toBe(200);
    const adminCookie = login.cookies.find(
      (cookie) => cookie.name === 'admin_token'
    )?.value;
    const csrf =
      login.cookies.find((cookie) => cookie.name === 'csrf_token')?.value ?? '';
    const review = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/panel/deposits/${deposit.id}`,
        payload,
        headers: {
          cookie: `admin_token=${adminCookie}; csrf_token=${csrf}`,
          'x-csrf-token': csrf,
        },
      });
    // Unlisted and missing statuses are 422, not a 500 inside the claim txn.
    expect((await review({ status: 'HACKED' })).statusCode).toBe(422);
    expect((await review({ action: 'approve' })).statusCode).toBe(422);
    // Nothing was claimed: still PENDING, no ledger rows…
    const still = await prisma.deposit.findUniqueOrThrow({
      where: { id: deposit.id },
    });
    expect(still.status).toBe('PENDING');
    expect(
      await prisma.transaction.count({
        where: { userId: user.id, type: 'DEPOSIT', referenceId: deposit.id },
      })
    ).toBe(0);
    // …so a real approval still works and credits exactly once.
    expect((await review({ status: 'APPROVED' })).statusCode).toBe(200);
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(wallet.realBalance.toString()).toBe('250');
  });

  it('rejects withdrawal review with an unlisted status before touching the DB', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/panel/auth/login',
      payload: {
        username: 'superadmin',
        password: process.env.ADMIN_DEFAULT_PASSWORD || 'change-this-immediately',
      },
    });
    // Assert the login: a wrong/absent super-admin password must fail HERE,
    // not later as an unexplained 403 on the review call.
    expect(login.statusCode, login.body).toBe(200);
    const adminCookie = login.cookies.find(
      (cookie) => cookie.name === 'admin_token'
    )?.value;
    const csrf =
      login.cookies.find((cookie) => cookie.name === 'csrf_token')?.value ?? '';
    const review = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'PATCH',
        url: '/api/v1/panel/withdrawals/does-not-exist',
        payload,
        headers: {
          cookie: `admin_token=${adminCookie}; csrf_token=${csrf}`,
          'x-csrf-token': csrf,
        },
      });
    // Validation runs before the DB lookup: 422 even for a bogus id…
    expect((await review({ status: 'HACKED' })).statusCode).toBe(422);
    expect((await review({})).statusCode).toBe(422);
    // …while a well-formed status reaches the lookup (404, not 422/500).
    expect((await review({ status: 'APPROVED' })).statusCode).toBe(404);
  });
});

skip('provably fair', () => {
  let access = '';
  const phone = `+92${String(Math.floor(3000000000 + Math.random() * 999999999))}`;
  trackedPhones.add(phone);

  beforeAll(async () => {
    await redis.del(keys.rl('signup', '127.0.0.1'));
    await redis.del(keys.rl('login', '127.0.0.1'));
    const fp = { userAgent: 'test', screenRes: '1x1', timezone: 'UTC', language: 'en' };
    const s = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { phone, password: 'Karachi-Play-77', fingerprint: fp },
    });
    access = (s.json() as { data: { accessToken: string } }).data.accessToken;
  });

  it('exposes active seed hash and rotates seeds atomically', async () => {
    const seed = await app.inject({
      method: 'GET',
      url: '/api/v1/provably-fair/active-seed',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(seed.statusCode).toBe(200);
    const body = seed.json() as { data: { serverSeedHash: string; nonce: number } };
    expect(body.data.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/provably-fair/rotate-seed',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(rotated.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/provably-fair/active-seed',
      headers: { authorization: `Bearer ${access}` },
    });
    const afterBody = after.json() as {
      data: { serverSeedHash: string; nonce: number };
    };
    expect(afterBody.data.serverSeedHash).not.toBe(body.data.serverSeedHash);
    expect(afterBody.data.nonce).toBe(0);
  });
});

// M-04: a claimed force round that fails to settle must RETURN to the budget.
skip('M-04 force budget regression', () => {
  let access = '';
  let clientSeed = '';
  let userId = '';
  const phone = `+92${String(Math.floor(3000000000 + Math.random() * 999999999))}`;
  const prevEnv = process.env.ALLOW_OUTCOME_OVERRIDES;

  async function resetWheelConfig() {
    await prisma.gameConfig.update({
      where: { slug: 'wheel' },
      data: { forceOverride: 'NONE', forceRoundsLeft: 0 },
    });
    await redis.del('cache:game_config:wheel');
  }

  beforeAll(async () => {
    await redis.del(keys.rl('signup', '127.0.0.1'));
    await redis.del(keys.rl('login', '127.0.0.1'));
    const fp = { userAgent: 'test', screenRes: '1x1', timezone: 'UTC', language: 'en' };
    const s = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { phone, password: 'Karachi-Play-77', fingerprint: fp },
    });
    access = (s.json() as { data: { accessToken: string } }).data.accessToken;
    const seedRes = await app.inject({
      method: 'GET',
      url: '/api/v1/provably-fair/active-seed',
      headers: { authorization: `Bearer ${access}` },
    });
    clientSeed = (seedRes.json() as { data: { clientSeed: string } }).data.clientSeed;
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${access}` },
    });
    userId = (me.json() as { data: { id: string } }).data.id;
    trackedUserIds.add(userId);
    // Fund through the canonical locked-ledger helper. A bare
    // `prisma.wallet.update` here credited the balance WITHOUT a Transaction
    // row, which left a permanent wallet-vs-ledger difference on whatever
    // database this suite ran against and made the worker's
    // reconciliationCheck fail forever (and throw, so the daily job failed).
    await prisma.$transaction((tx) =>
      applyBalanceChange(
        userId,
        'REAL',
        new Decimal(1000),
        'ADMIN_CREDIT',
        {
          referenceType: 'integration_test',
          referenceId: userId,
          description: 'Integration test funding',
        },
        tx
      )
    );
    process.env.ALLOW_OUTCOME_OVERRIDES = 'true';
    await prisma.gameConfig.update({
      where: { slug: 'wheel' },
      data: { forceOverride: 'FORCE_WIN', forceRoundsLeft: 2 },
    });
    await redis.del('cache:game_config:wheel');
  });

  afterAll(async () => {
    process.env.ALLOW_OUTCOME_OVERRIDES = prevEnv;
    await resetWheelConfig();
  });

  it('a rejected wager does NOT eat the claimed force round', async () => {
    // unknown tier → handler rejects (M-02) after the force claim fired
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/games/wheel/bet',
      headers: { authorization: `Bearer ${access}` },
      payload: { amount: 10, choices: { tier: 'vibranium' }, clientSeed },
    });
    expect(bad.statusCode).toBe(422);
    const cfgAfter = await prisma.gameConfig.findUniqueOrThrow({
      where: { slug: 'wheel' },
    });
    expect(cfgAfter.forceRoundsLeft).toBe(2); // refunded, not consumed
    const rounds = await prisma.gameRound.count({
      where: { userId, gameSlug: 'wheel' },
    });
    expect(rounds).toBe(0); // no audited round was created for the failed wager
  });

  it('a settled forced win consumes exactly one budget round and is audited', async () => {
    const bet = await app.inject({
      method: 'POST',
      url: '/api/v1/games/wheel/bet',
      headers: { authorization: `Bearer ${access}` },
      payload: { amount: 10, choices: { tier: 'blue' }, clientSeed },
    });
    expect(bet.statusCode).toBe(200);
    const body = bet.json() as { data: { roundId: string; result: string } };
    expect(body.data.result).toBe('WIN');
    const cfgAfter = await prisma.gameConfig.findUniqueOrThrow({
      where: { slug: 'wheel' },
    });
    expect(cfgAfter.forceRoundsLeft).toBe(1);
    const round = await prisma.gameRound.findUniqueOrThrow({
      where: { id: body.data.roundId },
    });
    expect(round.forceUsed).toBe('FORCE_WIN');
  });
});

// M-05: broadcast read state is PER USER (shared row + NotificationRead).
skip('M-05 broadcast read receipts', () => {
  let accessA = '';
  let accessB = '';
  let broadcastId = '';

  beforeAll(async () => {
    await redis.del(keys.rl('signup', '127.0.0.1'));
    const fp = { userAgent: 'test', screenRes: '1x1', timezone: 'UTC', language: 'en' };
    for (const which of ['A', 'B'] as const) {
      const phone = `+92${String(Math.floor(3000000000 + Math.random() * 999999999))}`;
      trackedPhones.add(phone);
      const s = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        payload: { phone, password: 'Karachi-Play-77', fingerprint: fp },
      });
      const acc = (s.json() as { data: { accessToken: string } }).data.accessToken;
      if (which === 'A') accessA = acc;
      else accessB = acc;
    }
    const n = await prisma.notification.create({
      data: { userId: null, type: 'broadcast', title: 't', body: 'b' },
    });
    broadcastId = n.id;
  });

  afterAll(async () => {
    await prisma.notificationRead.deleteMany({
      where: { notificationId: broadcastId },
    });
    await prisma.notification.deleteMany({ where: { id: broadcastId } });
  });

  const listFor = async (access: string) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { data: Array<{ id: string; isRead: boolean }> }).data;
  };

  it('both users see the broadcast as unread', async () => {
    for (const acc of [accessA, accessB]) {
      const list = await listFor(acc);
      const b = list.find((x) => x.id === broadcastId);
      expect(b).toBeTruthy();
      expect(b!.isRead).toBe(false);
    }
  });

  it('A marks it read; B still sees it unread (per-user state)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${broadcastId}/read`,
      headers: { authorization: `Bearer ${accessA}` },
    });
    expect(r.statusCode).toBe(200);
    const listA = await listFor(accessA);
    expect(listA.find((x) => x.id === broadcastId)!.isRead).toBe(true);
    const listB = await listFor(accessB);
    expect(listB.find((x) => x.id === broadcastId)!.isRead).toBe(false);
    // the shared row itself must remain untouched
    const raw = await prisma.notification.findUniqueOrThrow({
      where: { id: broadcastId },
    });
    expect(raw.isRead).toBe(false);
  });

  it('read-all covers broadcasts for B too', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      headers: { authorization: `Bearer ${accessB}` },
    });
    expect(r.statusCode).toBe(200);
    const listB = await listFor(accessB);
    expect(listB.find((x) => x.id === broadcastId)!.isRead).toBe(true);
  });
});
