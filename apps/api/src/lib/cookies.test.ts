// apps/api/src/lib/cookies.test.ts — cookie security flags.
//
// Why this matters: a `secure` cookie is SILENTLY DROPPED by the browser when
// it arrives over http://. The panel then accepts the password and immediately
// behaves as if nobody is signed in — no error, no log line. That is exactly
// what happens when the production stack is run locally over http, so
// COOKIE_SECURE exists to make the exception explicit and this test pins the
// rule that production stays secure by default.
import { afterEach, describe, expect, it } from 'vitest';
import { cookieSecureFor, insecureSecureCookieWarning, secureCookies } from './cookies';

const ORIGINAL = { NODE_ENV: process.env.NODE_ENV, COOKIE_SECURE: process.env.COOKIE_SECURE };

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL.NODE_ENV;
  if (ORIGINAL.COOKIE_SECURE === undefined) delete process.env.COOKIE_SECURE;
  else process.env.COOKIE_SECURE = ORIGINAL.COOKIE_SECURE;
});

describe('secureCookies', () => {
  it('is secure in production when nothing is set', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.COOKIE_SECURE;
    expect(secureCookies()).toBe(true);
  });

  it('is not secure outside production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.COOKIE_SECURE;
    expect(secureCookies()).toBe(false);
  });

  it('allows the documented opt-out for plain-HTTP testing', () => {
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_SECURE = 'false';
    expect(secureCookies()).toBe(false);
  });

  it('accepts 0 and no as false, 1 and yes as true', () => {
    process.env.NODE_ENV = 'production';
    for (const v of ['0', 'no', 'FALSE', ' False ']) {
      process.env.COOKIE_SECURE = v;
      expect(secureCookies(), v).toBe(false);
    }
    process.env.NODE_ENV = 'development';
    for (const v of ['1', 'yes', 'TRUE']) {
      process.env.COOKIE_SECURE = v;
      expect(secureCookies(), v).toBe(true);
    }
  });

  it('falls back to the NODE_ENV default for a typo, never downgrading production', () => {
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_SECURE = 'flase'; // the typo an operator will actually type
    expect(secureCookies()).toBe(true);
    process.env.NODE_ENV = 'development';
    process.env.COOKIE_SECURE = 'yess';
    expect(secureCookies()).toBe(false);
  });

  it('treats an empty value (as passed by compose) as unset', () => {
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_SECURE = '';
    expect(secureCookies()).toBe(true);
  });
});

// ── cookieSecureFor: the whole-request rule ────────────────────────────────
// The local stack runs the API image with NODE_ENV=production over
// http://localhost:8080. The old NODE_ENV-only rule marked the admin session
// cookie `Secure`, the browser discarded it silently, and the panel looped
// between "Welcome back, admin" and the login page. These cases pin the fix.
describe('cookieSecureFor', () => {
  it('does NOT mark cookies secure when a production request arrived over http', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.COOKIE_SECURE;
    expect(cookieSecureFor({ protocol: 'http' })).toBe(false);
  });

  it('keeps cookies secure for a production request that really is https', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.COOKIE_SECURE;
    expect(cookieSecureFor({ protocol: 'https' })).toBe(true);
  });

  it('stays safe when there is no request to inspect', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.COOKIE_SECURE;
    expect(cookieSecureFor()).toBe(true);
    expect(cookieSecureFor({})).toBe(true);
  });

  it('is never secure outside production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.COOKIE_SECURE;
    expect(cookieSecureFor({ protocol: 'http' })).toBe(false);
    expect(cookieSecureFor({ protocol: 'https' })).toBe(false);
  });

  it('still honours an explicit COOKIE_SECURE in both directions', () => {
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_SECURE = 'false';
    expect(cookieSecureFor({ protocol: 'https' })).toBe(false);
    process.env.COOKIE_SECURE = 'true';
    expect(cookieSecureFor({ protocol: 'http' })).toBe(true);
  });

  it('never downgrades production on a typo', () => {
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_SECURE = 'flase'; // the typo an operator will actually type
    // Unrecognised value → fall back to the scheme rule: https stays Secure,
    // and plain http is not marked Secure (marking it would silently re-create
    // the login loop this whole function exists to prevent).
    expect(cookieSecureFor({ protocol: 'https' })).toBe(true);
    expect(cookieSecureFor({ protocol: 'http' })).toBe(false);
    expect(cookieSecureFor()).toBe(true); // no request → safe default
  });
});

describe('insecureSecureCookieWarning', () => {
  it('flags exactly the case that silently breaks a login', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.COOKIE_SECURE;
    expect(insecureSecureCookieWarning({ protocol: 'http' })).toBe(false); // fixed: not secure over http
    process.env.COOKIE_SECURE = 'true'; // operator forced it on anyway
    expect(insecureSecureCookieWarning({ protocol: 'http' })).toBe(true);
    expect(insecureSecureCookieWarning({ protocol: 'https' })).toBe(false);
  });
});
