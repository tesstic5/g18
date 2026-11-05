// apps/api/src/lib/env-check.test.ts
//
// Context: making compose variables hard-required (`${VAR:?msg}`) broke real
// deployments — `docker compose up` aborted during interpolation with a single
// cryptic message, before any container started, and only reported ONE missing
// variable at a time. The compose files now use fallbacks and this checker
// reports the whole picture at boot instead.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { checkEnvironment } from './env-check';

const SAVED = { ...process.env };

function setEnv(env: Record<string, string | undefined>) {
  for (const k of [
    'NODE_ENV',
    'DATABASE_URL',
    'REDIS_URL',
    'ENCRYPTION_KEY',
    'AES_ENCRYPTION_KEY',
    'JWT_PRIVATE_KEY',
    'JWT_PRIVATE_KEY_B64',
    'FRONTEND_URL',
    'S3_PUBLIC_ENDPOINT',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'PG_PASSWORD',
    'REDIS_PASSWORD',
    'COOKIE_SECRET',
    'ADMIN_DEFAULT_PASSWORD',
  ])
    delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
}

/** A fully-configured production environment. */
const GOOD = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u@db:5432/casino',
  REDIS_URL: 'redis://redis:6379',
  ENCRYPTION_KEY: 'a'.repeat(64),
  JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----x',
  FRONTEND_URL: 'https://example.com',
  S3_PUBLIC_ENDPOINT: 'https://example.com/storage',
  S3_ACCESS_KEY: 'realkey',
  S3_SECRET_KEY: 'realsecret',
  PG_PASSWORD: 'strong',
  REDIS_PASSWORD: 'strong',
  COOKIE_SECRET: 'strong-unique-cookie-secret',
  ADMIN_DEFAULT_PASSWORD: 'strong-unique',
};

beforeEach(() => setEnv(GOOD));
afterEach(() => {
  process.env = { ...SAVED };
});

const msgs = () =>
  checkEnvironment()
    .map((f) => f.message)
    .join(' | ');
const fatals = () => checkEnvironment().filter((f) => f.level === 'fatal');

describe('checkEnvironment', () => {
  it('reports nothing when everything is configured', () => {
    expect(checkEnvironment()).toEqual([]);
  });

  it('accepts the ORIGINAL AES_ENCRYPTION_KEY name', () => {
    // Existing deployments set this name; renaming it must not break them.
    setEnv({ ...GOOD, ENCRYPTION_KEY: undefined, AES_ENCRYPTION_KEY: 'b'.repeat(64) });
    expect(checkEnvironment()).toEqual([]);
  });

  it('is fatal in production when NEITHER encryption key name is set', () => {
    setEnv({ ...GOOD, ENCRYPTION_KEY: undefined, AES_ENCRYPTION_KEY: undefined });
    expect(fatals().some((f) => f.message.includes('ENCRYPTION_KEY'))).toBe(true);
  });

  it('is only a warning in development', () => {
    setEnv({
      ...GOOD,
      NODE_ENV: 'development',
      ENCRYPTION_KEY: undefined,
      AES_ENCRYPTION_KEY: undefined,
    });
    expect(fatals()).toHaveLength(0);
  });

  it('reports EVERY problem at once, not just the first', () => {
    // The whole point: one redeploy should reveal all of it.
    setEnv({ NODE_ENV: 'production' });
    const found = checkEnvironment();
    expect(found.length).toBeGreaterThanOrEqual(4);
    const all = found.map((f) => f.message).join(' ');
    for (const v of ['DATABASE_URL', 'REDIS_URL', 'ENCRYPTION_KEY', 'FRONTEND_URL']) {
      expect(all).toContain(v);
    }
  });

  it('flags a missing FRONTEND_URL as fatal in production (CORS would break)', () => {
    setEnv({ ...GOOD, FRONTEND_URL: undefined });
    expect(fatals().some((f) => f.message.includes('FRONTEND_URL'))).toBe(true);
  });

  it('warns about a missing S3_PUBLIC_ENDPOINT without blocking boot', () => {
    setEnv({ ...GOOD, S3_PUBLIC_ENDPOINT: undefined });
    expect(fatals()).toHaveLength(0);
    expect(msgs()).toContain('S3_PUBLIC_ENDPOINT');
  });

  it('is FATAL in production when example credentials are still in place (C-06)', () => {
    setEnv({
      ...GOOD,
      S3_ACCESS_KEY: 'minioadmin',
      ADMIN_DEFAULT_PASSWORD: 'change-this-now',
    });
    const all = msgs();
    expect(all).toContain('S3_ACCESS_KEY');
    expect(all).toContain('ADMIN_DEFAULT_PASSWORD');
    // C-06: a platform must not boot for real money with guessable secrets.
    expect(fatals().length).toBeGreaterThanOrEqual(2);
  });

  it('is fatal in production when a required credential is unset (C-06)', () => {
    setEnv({ ...GOOD, ADMIN_DEFAULT_PASSWORD: undefined });
    expect(msgs()).toContain('ADMIN_DEFAULT_PASSWORD');
    expect(fatals().length).toBeGreaterThanOrEqual(1);
  });

  it('does not demand production credentials when NOT in production', () => {
    setEnv({ ...GOOD, NODE_ENV: 'development', ADMIN_DEFAULT_PASSWORD: undefined });
    expect(fatals()).toHaveLength(0);
  });

  it('warns that an unset JWT key logs everyone out on redeploy', () => {
    setEnv({ ...GOOD, NODE_ENV: 'development', JWT_PRIVATE_KEY: undefined });
    expect(msgs()).toContain('JWT_PRIVATE_KEY');
  });

  it('is FATAL in production when the shipped example ENCRYPTION_KEY / COOKIE_SECRET are in place', () => {
    setEnv({
      ...GOOD,
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      COOKIE_SECRET: 'cookie-secret',
    });
    const all = msgs();
    expect(all).toContain('ENCRYPTION_KEY');
    expect(all).toContain('COOKIE_SECRET');
    expect(fatals().length).toBeGreaterThanOrEqual(2);
  });

  it('only warns (not fatal) in production when COOKIE_SECRET is unset — upgrade safety', () => {
    setEnv({ ...GOOD, COOKIE_SECRET: undefined });
    expect(fatals().some((f) => f.message.includes('COOKIE_SECRET'))).toBe(false);
    expect(msgs()).toContain('COOKIE_SECRET');
  });
});
