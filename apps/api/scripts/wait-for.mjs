#!/usr/bin/env node
// apps/api/scripts/wait-for.mjs — dependency readiness probe for the production
// entrypoint. Plain Node (no tsx, no src/): uses only runtime dependencies.
// Usage: node scripts/wait-for.mjs            → postgres + redis, ~60s budget
//        WAIT_FOR_SECONDS=180 node scripts/…  → longer budget (slow small VPS)
//
// Postgres is a HARD gate: without it the API cannot serve anything, so a
// failure exits non-zero and the container stops instead of running broken.
// Redis is fail-open (the API degrades gracefully without it — D-104).
//
// DIAGNOSABILITY: this probe is the FIRST thing a deploy runs, so it is also
// the first place a misconfiguration shows up — and "Postgres unreachable"
// used to be the whole story, because the real error was swallowed by the
// catch. That message is identical for a wrong host, a wrong password, a
// missing database and a firewall, which made a 60-second failure impossible
// to act on. It now reports the connection target (password redacted) and a
// plain-language reason for the last failure, so the log says what to fix.
import { Redis } from 'ioredis';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const budgetSec = Number(process.env.WAIT_FOR_SECONDS || 60) || 60;
const deadline = Date.now() + budgetSec * 1000;

/** host:port db=… user=… — never the password (container logs are shared). */
function describePgTarget(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432} db=${u.pathname.replace(/^\//, '') || '?'} user=${
      decodeURIComponent(u.username) || '?'
    }`;
  } catch {
    return '(DATABASE_URL could not be parsed as a URL)';
  }
}

function describeRedisTarget(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 6379} db=${u.pathname.replace(/^\//, '') || '0'}`;
  } catch {
    return '(REDIS_URL could not be parsed as a URL)';
  }
}

/** Turn a pg error into the sentence an operator needs. */
function pgReason(err) {
  const code = String(err?.code || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return 'host does not resolve — DATABASE_URL must use the compose service name (postgres), and both services must share a network';
  if (code === 'ECONNREFUSED')
    return 'connection refused — nothing is listening on that host:port';
  if (code === '28P01' || /password authentication failed/i.test(err?.message || ''))
    return 'password authentication failed — the password in DATABASE_URL does not match the one Postgres was initialised with (POSTGRES_PASSWORD is ignored once the pg_data volume exists, so changing it later needs a new volume)';
  if (code === '28000') return 'role is not permitted to log in';
  if (code === '3D000')
    return 'database does not exist — the path in DATABASE_URL must be /casino';
  if (code === '42P01' || code === '42501') return 'connected, but the role lacks access to the schema';
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ECONNRESET')
    return 'network timeout — firewall, or the database is not on the same Docker network';
  return err?.message ? String(err.message).split('\n')[0] : 'unknown error';
}

async function pgReady() {
  try {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: pgReason(e) };
  }
}

async function redisReady() {
  try {
    const r = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    // ioredis logs "Unhandled error event" + a stack trace when it cannot
    // connect. Redis is fail-open here, so the connection error is EXPECTED and
    // already reported below — without this listener the log looks like a crash
    // right before the real message.
    r.on('error', () => undefined);
    await r.connect();
    await r.ping();
    await r.quit();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message ? String(e.message).split('\n')[0] : 'unknown error' };
  }
}

const pgTarget = describePgTarget(process.env.DATABASE_URL);
const rdTarget = describeRedisTarget(process.env.REDIS_URL);
console.log(`[wait-for] Postgres target ${pgTarget} · Redis target ${rdTarget} · budget ${budgetSec}s`);

let pg = { ok: false, reason: 'not attempted' };
let rd = { ok: false, reason: 'not attempted' };
let attempts = 0;
while (Date.now() < deadline && !(pg.ok && rd.ok)) {
  attempts += 1;
  if (!pg.ok) pg = await pgReady();
  if (!rd.ok) rd = await redisReady();
  if (!pg.ok || !rd.ok) await sleep(2000);
}

if (!pg.ok) {
  console.error(
    `[wait-for] FATAL: Postgres unreachable after ${budgetSec}s (${attempts} attempts, target ${pgTarget})\n[wait-for] reason: ${pg.reason}`
  );
  process.exit(1);
}
if (!rd.ok)
  console.warn(
    `[wait-for] WARN: Redis unreachable after ${budgetSec}s — continuing (fail-open). Target ${rdTarget}. Reason: ${rd.reason}`
  );
console.log('[wait-for] dependencies ready');
