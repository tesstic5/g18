// apps/api/src/routes/panel-login-cookie.test.ts — the admin session cookie.
//
// Regression guard for the reported bug: "it says Welcome back, admin, then the
// page reloads and asks me to log in again."
//
// The cause was never the password — the login succeeded — it was the cookie:
// `admin_token` was marked `Secure` purely because NODE_ENV=production, even
// though the request arrived over plain http:// (a local Docker run). Every
// browser SILENTLY DISCARDS a `Secure` cookie that arrives over http, so the
// panel's very next call — GET /panel/auth/me — was unauthenticated (401) and
// the layout redirected straight back to the login page. Forever.
//
// These cases drive the REAL panel routes over HTTP with a real database and
// assert on the actual Set-Cookie header, plus a full login → /panel/auth/me
// round trip, so the flag can never silently regress again.
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import bcrypt from 'bcrypt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeErrorHandler } from '../lib/core';
import { prisma } from '../db/prisma';
import { panelRoutes } from './panel';

const USERNAME = 'cookie-regression-admin';
const PASSWORD = 'Cookie!2345Secret';

const ORIGINAL = {
  NODE_ENV: process.env.NODE_ENV,
  COOKIE_SECURE: process.env.COOKIE_SECURE,
};

let app: FastifyInstance;
let adminId = '';

/** Every Set-Cookie the response carried, as raw strings. */
function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
}

function cookieNamed(list: string[], name: string): string {
  const found = list.find((c) => c.startsWith(`${name}=`));
  if (!found) throw new Error(`no ${name} cookie in: ${list.join(' | ')}`);
  return found;
}

/** "a=b; Path=/; HttpOnly" → "a=b" (what a browser would send back). */
function cookiePairs(list: string[]): string {
  return list
    .map((c) => c.split(';')[0]?.trim() ?? '')
    .filter(Boolean)
    .join('; ');
}

function login(opts: { headers?: Record<string, string>; remoteAddress?: string } = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/panel/auth/login',
    payload: { username: USERNAME, password: PASSWORD },
    // A fresh address keeps the 20-per-15-min login limiter out of the way.
    remoteAddress: opts.remoteAddress ?? `10.9.${Math.floor(Math.random() * 200)}.7`,
    headers: opts.headers ?? {},
  });
}

beforeAll(async () => {
  // The local stack runs the production image over http:// — reproduce exactly.
  process.env.NODE_ENV = 'production';
  delete process.env.COOKIE_SECURE;

  // A real key pair: admin tokens are RS256 and must verify on the same run.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY = publicKey;

  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const admin = await prisma.adminUser.upsert({
    where: { username: USERNAME },
    update: { passwordHash, isSuperAdmin: true },
    create: {
      username: USERNAME,
      passwordHash,
      isSuperAdmin: true,
      displayName: 'Cookie Regression Admin',
    },
  });
  adminId = admin.id;

  app = Fastify({
    logger: false,
    // Trusting the loopback proxy is what lets X-Forwarded-Proto reach
    // request.protocol — the same mechanism Traefik/Nginx use in production.
    trustProxy: ['127.0.0.1'],
  });
  app.setErrorHandler(makeErrorHandler(app.log.error.bind(app.log)));
  await app.register(cookie, { secret: 'panel-login-cookie-test' });
  // server.ts mounts the panel router at /api/v1/panel — same prefix here.
  await app.register(panelRoutes, { prefix: '/api/v1/panel' });
  await app.ready();
}, 60_000);

afterAll(async () => {
  if (adminId) await prisma.adminUser.deleteMany({ where: { id: adminId } });
  await app?.close();
  process.env.NODE_ENV = ORIGINAL.NODE_ENV;
  if (ORIGINAL.COOKIE_SECURE === undefined) delete process.env.COOKIE_SECURE;
  else process.env.COOKIE_SECURE = ORIGINAL.COOKIE_SECURE;
});

describe('admin login cookie over plain http (the "signed in, then asked again" bug)', () => {
  it('does NOT mark the session cookie Secure, so the browser keeps it', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);

    const adminToken = cookieNamed(setCookies(res), 'admin_token');
    // The whole bug in one assertion: `Secure` here + http:// in the address
    // bar = the browser throws the cookie away and the panel loops.
    expect(adminToken).not.toMatch(/;\s*Secure/i);
    // The security flags that must NOT change.
    expect(adminToken).toMatch(/HttpOnly/i);
    expect(adminToken).toMatch(/SameSite=Strict/i);
    expect(adminToken).toMatch(/Path=\/api\/v1/i);
    expect(adminToken).toMatch(/Max-Age=28800/i);
  });

  it('keeps the CSRF cookie usable over http as well', async () => {
    const res = await login();
    const csrf = cookieNamed(setCookies(res), 'csrf_token');
    expect(csrf).not.toMatch(/;\s*Secure/i);
    expect(csrf).toMatch(/SameSite=Lax/i);
    expect(res.json().data.csrfToken).toBeTruthy();
  });

  it('the cookie it hands out really authenticates the next request', async () => {
    const res = await login();
    const pairs = cookiePairs(setCookies(res));

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/panel/auth/me',
      headers: { cookie: pairs },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.username).toBe(USERNAME);
  });

  it('is the exact 401 the panel layout reacts to when the cookie is missing', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/v1/panel/auth/me' });
    expect(me.statusCode).toBe(401);
    expect(me.json().code).toBe('AUTH_003');
  });
});

describe('an admin restored from a backup (stale lastActiveAt) can still sign in', () => {
  it('does not bounce a correct login with "session ended after N minutes of inactivity"', async () => {
    // Reproduces the VPS report: the database was restored from a local dump, so
    // lastActiveAt was hours old while lastLoginAt was current. The panel-auth
    // middleware ends an idle session and only refreshes that stamp AFTER a
    // request has passed the check — so without stamping it at login, a correct
    // password produced 200 on /auth/login and 401 AUTH_002 on the very next
    // request, for ever. Same admin, same password, same code as the other cases.
    await prisma.adminUser.update({
      where: { id: adminId },
      data: { lastActiveAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });

    const res = await login();
    expect(res.statusCode).toBe(200);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/panel/auth/me',
      headers: { cookie: cookiePairs(setCookies(res)) },
    });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().data.username).toBe(USERNAME);

    const after = await prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    expect(Date.now() - new Date(after.lastActiveAt as Date).getTime()).toBeLessThan(60_000);
  });
});

describe('admin login cookie behind TLS (production deployment unchanged)', () => {
  it('DOES mark the session cookie Secure when the request really is https', async () => {
    // Only a TRUST_PROXY'd hop may set X-Forwarded-Proto, so this request comes
    // from the trusted loopback — exactly like Traefik in front of the API.
    const res = await login({
      headers: { 'x-forwarded-proto': 'https' },
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    expect(cookieNamed(setCookies(res), 'admin_token')).toMatch(/;\s*Secure/i);
  });

  it('lets no untrusted client claim https just to change the cookie flag', async () => {
    const res = await login({
      headers: { 'x-forwarded-proto': 'https' },
      remoteAddress: '203.0.113.9', // not in trustProxy → header is ignored
    });
    expect(res.statusCode).toBe(200);
    expect(cookieNamed(setCookies(res), 'admin_token')).not.toMatch(/;\s*Secure/i);
  });

  it('still honours an explicit COOKIE_SECURE=true over http (operator override)', async () => {
    process.env.COOKIE_SECURE = 'true';
    try {
      const res = await login();
      expect(cookieNamed(setCookies(res), 'admin_token')).toMatch(/;\s*Secure/i);
    } finally {
      delete process.env.COOKIE_SECURE;
    }
  });

  it('honours COOKIE_SECURE=false so a local http run is never locked out', async () => {
    process.env.COOKIE_SECURE = 'false';
    try {
      const res = await login();
      expect(cookieNamed(setCookies(res), 'admin_token')).not.toMatch(/;\s*Secure/i);
    } finally {
      delete process.env.COOKIE_SECURE;
    }
  });
});
