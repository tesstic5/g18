// apps/api/src/lib/csrf.ts — double-submit CSRF cookie (docs/14).
//
// The browser JS must READ the cookie to echo it in X-CSRF-Token, so this is
// deliberately NOT httpOnly. `sameSite: 'lax'` (not strict): Strict withholds
// the cookie on any cross-site navigation into the app, which left admins
// logged-in (admin_token is httpOnly + 8h) but unable to Approve a deposit.
//
// Cross-origin deploys (web on games.example.com, API on api.example.com) are
// same-site but NOT same-origin: the cookie IS sent to the API, but
// `document.cookie` on the web origin is empty. Callers must therefore also
// return the token in JSON / the X-CSRF-Token response header so the client
// can populate the request header from memory.
import crypto from 'crypto';
import { cookieSecureFor } from './cookies';

export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';
export const PLAYER_CSRF_MAX_AGE = 7 * 24 * 3600;
export const ADMIN_CSRF_MAX_AGE = 8 * 3600;

type CookieReply = {
  setCookie: (name: string, value: string, opts?: Record<string, unknown>) => unknown;
  clearCookie?: (name: string, opts?: Record<string, unknown>) => unknown;
  header: (name: string, value: string) => unknown;
};

type CookieRequest = {
  cookies?: Record<string, string | undefined>;
  /** Fastify sets this from the socket, or from X-Forwarded-Proto for a
   *  TRUST_PROXY'd proxy — see lib/cookies.ts cookieSecureFor(). */
  protocol?: string;
};

function cookieOpts(maxAgeSec: number, request?: CookieRequest): Record<string, unknown> {
  return {
    httpOnly: false,
    sameSite: 'lax',
    // Follow the scheme this request arrived on: a `Secure` CSRF cookie over
    // http:// is dropped by the browser, which then looks like "the panel keeps
    // forgetting me" instead of anything mentioning cookies.
    secure: cookieSecureFor(request),
    path: '/',
    maxAge: maxAgeSec,
  };
}

export function setCsrfCookie(
  reply: CookieReply,
  token: string,
  maxAgeSec: number,
  request?: CookieRequest
): void {
  reply.setCookie(CSRF_COOKIE, token, cookieOpts(maxAgeSec, request));
  reply.header('X-CSRF-Token', token);
}

/** Mint a fresh token (login / signup). */
export function mintCsrf(
  reply: CookieReply,
  maxAgeSec: number,
  request?: CookieRequest
): string {
  const token = crypto.randomUUID();
  setCsrfCookie(reply, token, maxAgeSec, request);
  return token;
}

/**
 * Echo the existing cookie or mint one. `/auth/me` and `/panel/auth/me` call
 * this so a session that outlived the cookie (browser restart vs 8h admin
 * token, Strict leftover, cleared cookies) self-heals without a re-login.
 */
export function ensureCsrf(
  request: CookieRequest,
  reply: CookieReply,
  maxAgeSec: number
): string {
  const existing = request.cookies?.[CSRF_COOKIE];
  if (existing && existing.length >= 16) {
    setCsrfCookie(reply, existing, maxAgeSec, request);
    return existing;
  }
  return mintCsrf(reply, maxAgeSec, request);
}

export function clearCsrfCookie(reply: CookieReply): void {
  reply.clearCookie?.(CSRF_COOKIE, { path: '/' });
}
