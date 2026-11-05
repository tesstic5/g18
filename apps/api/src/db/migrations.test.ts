// apps/api/src/db/migrations.test.ts — runs the REAL migrations and the REAL
// money-path SQL against a real Postgres engine (PGlite: Postgres compiled to
// WASM, in-process — no daemon, no Docker, no external service).
//
// Why this exists: the raw SQL in this codebase was previously unverified, and
// that is exactly where the worst bug hid — the worker's rakeback/leaderboard/
// win-streak queries used unquoted snake_case identifiers against Prisma's
// quoted camelCase columns, so they threw on EVERY run and rakeback never paid
// out. Nobody noticed because the worker only logged the failure.
//
// Unit tests with mocked Prisma cannot catch that class of bug. These can.
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { freemem } from 'node:os';

const MIGRATIONS_DIR = join(__dirname, '../../prisma/migrations');
/** Minimal structural type — avoids a top-level `import type` of PGlite. */
interface PgLike {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }>;
}
let db: PgLike;
let PGliteCtor: new () => PgLike;

// PGlite is Postgres compiled to WASM and needs ~1GB of headroom. On a
// constrained machine the OS OOM-kills the vitest worker, which silently
// removed this whole file from the run — the summary read "16 passed (17)"
// with no hint that 12 checks never executed.
//
// `os.freemem()` is not a reliable predictor (it excludes reclaimable cache),
// so these run only where we KNOW there is capacity: CI, or an explicit
// opt-in via RUN_DB_TESTS=1 locally.
//
//   CI=true            → always run (the GitHub workflow sets this)
//   RUN_DB_TESTS=1     → force locally
//   otherwise          → skip, loudly
const forced = process.env.RUN_DB_TESTS === '1';
const onCI = process.env.CI === 'true' || process.env.CI === '1';
const enoughMemory = onCI || forced;
if (!enoughMemory) {
  console.warn(
    `[migrations.test] SKIPPING 12 checks — PGlite needs ~1GB and this machine has ` +
      `${Math.round(freemem() / 1024 / 1024)}MB reported free. ` +
      'These migration/SQL checks did NOT run. Force with RUN_DB_TESTS=1; CI runs them always.'
  );
}

let pgliteAvailable = enoughMemory;
let skipReason = '';

/** Apply every migration in lexical (= chronological) order. */
async function applyMigrations(client: {
  exec(sql: string): Promise<unknown>;
}): Promise<string[]> {
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of dirs) {
    await client.exec(readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'));
  }
  return dirs;
}

async function seedUserWithWallet(
  client: { exec(sql: string): Promise<unknown> },
  balance = 500
) {
  await client.exec(`INSERT INTO "User"(id,phone,"passwordHash","referralCode","updatedAt")
    VALUES ('u1','+923001234567','h','R1',now());`);
  await client.exec(`INSERT INTO "Wallet"(id,"userId","realBalance","updatedAt")
    VALUES ('w1','u1',${balance},now());`);
}

/** Assert a statement is REJECTED by the database. */
async function expectRejected(
  client: { exec(sql: string): Promise<unknown> },
  sql: string
) {
  await expect(client.exec(sql)).rejects.toThrow();
}

beforeAll(async () => {
  if (!enoughMemory) return;
  try {
    ({ PGlite: PGliteCtor } = await import('@electric-sql/pglite'));
    db = new PGliteCtor();
    await db.query('SELECT 1');
  } catch (e) {
    pgliteAvailable = false;
    skipReason = (e as Error).message;
    console.warn(
      `[migrations.test] SKIPPED — PGlite could not start (${skipReason}). ` +
        'This usually means the runner is short on memory. CI has enough; ' +
        'these tests must not be treated as passing.'
    );
    return;
  }
  await applyMigrations(db);
  await seedUserWithWallet(db);
  await db.exec(`INSERT INTO "PayoutAccount"(id,"userId",type,label,"accountDetails")
    VALUES ('pa1','u1','bank','Main','encrypted');`);
  await db.exec(`INSERT INTO "GameConfig"(slug,"displayName","baseRtp","winRate","houseEdge","updatedAt")
    VALUES ('dice','Dice',96,49,4,now());`);
  await db.exec(`INSERT INTO "SeedPair"(id,"userId","serverSeed","serverSeedHash","clientSeed","createdAt")
    VALUES ('sp1','u1','s','h','c',now());`);
}, 60_000);

describe('migrations', () => {
  // Guard against the original failure mode: these checks quietly not running.
  // Locally they may skip (documented, and printed loudly). In CI they MUST
  // execute — if PGlite can't start there, that is a red build, not a pass.
  it('actually runs in CI (a silent skip is a failure)', () => {
    const onCI = process.env.CI === 'true' || process.env.CI === '1';
    if (onCI) {
      expect(
        pgliteAvailable,
        `PGlite did not start in CI (${skipReason || 'unknown'}) — these 12 migration/SQL ` +
          'checks did not run. Do not treat this build as green.'
      ).toBe(true);
    } else {
      expect(typeof pgliteAvailable).toBe('boolean');
    }
  });

  it('every migration applies cleanly to a real Postgres engine', async () => {
    if (!pgliteAvailable) return;
    const fresh = new PGliteCtor();
    const applied = await applyMigrations(fresh);
    expect(applied.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('wallet balance constraints', () => {
  it('rejects a negative real balance', async () => {
    if (!pgliteAvailable) return;
    await expectRejected(db, `UPDATE "Wallet" SET "realBalance" = -1 WHERE id='w1';`);
  });

  it('rejects a negative bonus balance', async () => {
    if (!pgliteAvailable) return;
    await expectRejected(
      db,
      `UPDATE "Wallet" SET "bonusBalance" = -0.01 WHERE id='w1';`
    );
  });

  it('allows zero and positive balances', async () => {
    if (!pgliteAvailable) return;
    await db.exec(`UPDATE "Wallet" SET "realBalance" = 0 WHERE id='w1';`);
    await db.exec(`UPDATE "Wallet" SET "realBalance" = 100.50 WHERE id='w1';`);
    const r = await db.query<{ realBalance: string }>(
      `SELECT "realBalance" FROM "Wallet" WHERE id='w1'`
    );
    expect(Number(r.rows[0]!.realBalance)).toBe(100.5);
  });
});

describe('withdrawal arithmetic constraints', () => {
  it('accepts a withdrawal where net = amount - fee', async () => {
    if (!pgliteAvailable) return;
    await db.exec(`INSERT INTO "Withdrawal"(id,"userId",amount,fee,"netAmount","payoutAccountId","updatedAt")
      VALUES ('wd_ok','u1',1000,20,980,'pa1',now());`);
    const r = await db.query<{ netAmount: string }>(
      `SELECT "netAmount" FROM "Withdrawal" WHERE id='wd_ok'`
    );
    expect(Number(r.rows[0]!.netAmount)).toBe(980);
  });

  it('rejects net != amount - fee (guards the fee-collection fix)', async () => {
    if (!pgliteAvailable) return;
    // This is the shape of the original bug: fee charged to nobody.
    await expectRejected(
      db,
      `INSERT INTO "Withdrawal"(id,"userId",amount,fee,"netAmount","payoutAccountId","updatedAt")
      VALUES ('wd_bad','u1',1000,20,1000,'pa1',now());`
    );
  });

  it('rejects a negative fee', async () => {
    if (!pgliteAvailable) return;
    await expectRejected(
      db,
      `INSERT INTO "Withdrawal"(id,"userId",amount,fee,"netAmount","payoutAccountId","updatedAt")
      VALUES ('wd_neg','u1',1000,-5,1005,'pa1',now());`
    );
  });
});

describe('money-path SQL executes against real Postgres', () => {
  it('lockWallet SELECT ... FOR UPDATE is valid', async () => {
    if (!pgliteAvailable) return;
    await db.exec('BEGIN');
    const r = await db.query(`SELECT id FROM "Wallet" WHERE "userId" = $1 FOR UPDATE`, [
      'u1',
    ]);
    await db.exec('COMMIT');
    expect(r.rows).toHaveLength(1);
  });

  it('worker rakeback query returns the correct net loss', async () => {
    if (!pgliteAvailable) return;
    await db.exec(`INSERT INTO "Transaction"(id,"walletId","userId",type,"walletType",amount,"balanceBefore","balanceAfter","createdAt")
      VALUES ('t1','w1','u1','BET','REAL',100,500,400,now()),
             ('t2','w1','u1','WIN','REAL',30,400,430,now());`);
    const r = await db.query<{ userId: string; lost: string }>(
      `
      SELECT "userId", SUM(CASE WHEN type='BET' THEN amount ELSE -amount END)::text as lost
      FROM "Transaction"
      WHERE "walletType"='REAL' AND type IN ('BET','WIN')
        AND "createdAt" >= $1 AND "createdAt" < $2
      GROUP BY "userId" HAVING SUM(CASE WHEN type='BET' THEN amount ELSE -amount END) > 0`,
      [new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000)]
    );
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0]!.lost)).toBe(70); // 100 staked - 30 won
  });

  it('worker win-streak reset query is valid', async () => {
    if (!pgliteAvailable) return;
    await db.exec(`INSERT INTO "WinStreak"(id,"userId","currentStreak","lastWinAt","updatedAt")
      VALUES ('s1','u1',5, now() - interval '48 hours', now());`);
    await db.exec(`UPDATE "WinStreak" SET "currentStreak" = 0
      WHERE "lastWinAt" IS NOT NULL AND "lastWinAt" < now() - interval '24 hours'`);
    const r = await db.query<{ currentStreak: number }>(
      `SELECT "currentStreak" FROM "WinStreak" WHERE id='s1'`
    );
    expect(r.rows[0]!.currentStreak).toBe(0);
  });

  it('worker leaderboard snapshot query is valid', async () => {
    if (!pgliteAvailable) return;
    await db.exec(`INSERT INTO "GameRound"(id,"userId","gameSlug","betAmount","walletTypeUsed","seedPairId","clientSeed",nonce,"rawOutcome","mappedOutcome",result,"payoutMultiplier","payoutAmount","configSnapshot","configSnapshotHash","createdAt")
      VALUES ('g1','u1','dice',100,'REAL','sp1','c',0,0.5,'{}','WIN',2,200,'{}','x',now());`);
    const r = await db.query<{ score: string; rounds: string }>(
      `
      SELECT "userId", SUM("betAmount")::text as score, SUM("payoutAmount")::text as won,
             MAX("payoutAmount")::text as biggest, COUNT(*) as rounds
      FROM "GameRound" WHERE to_char("createdAt", 'YYYY-MM-DD') = $1 AND demo = false
        AND "result" <> 'PENDING'
      GROUP BY "userId" ORDER BY SUM("betAmount") DESC LIMIT 50`,
      [new Date().toISOString().slice(0, 10)]
    );
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0]!.score)).toBe(100);
  });

  it('still allows a losing round (payout 0)', async () => {
    if (!pgliteAvailable) return;
    await db.exec(`INSERT INTO "GameRound"(id,"userId","gameSlug","betAmount","walletTypeUsed","seedPairId","clientSeed",nonce,"rawOutcome","mappedOutcome",result,"payoutMultiplier","payoutAmount","configSnapshot","configSnapshotHash","createdAt")
      VALUES ('g2','u1','dice',50,'REAL','sp1','c',1,0.9,'{}','BUST',0,0,'{}','x',now());`);
    const r = await db.query<{ payoutAmount: string }>(
      `SELECT "payoutAmount" FROM "GameRound" WHERE id='g2'`
    );
    expect(Number(r.rows[0]!.payoutAmount)).toBe(0);
  });
});
