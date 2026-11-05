// apps/api/src/lib/cookies.ts — one place that decides cookie security flags.
//
// Session cookies (player refresh, admin panel, CSRF) are `secure` whenever
// NODE_ENV=production. That is correct for a real deployment, but it makes
// plain-HTTP access impossible: a browser SILENTLY DROPS a `secure` cookie that
// arrives over http://, so the panel accepts the password and then behaves as
// if nobody is signed in — a confusing failure with no error message at all.
//
// `COOKIE_SECURE` exists for exactly those cases (a local run, IP-only testing,
// an internal VPN host). It is opt-out, never opt-in:
//
//   unset            → follow the request's real scheme (see cookieSecureFor)
//   COOKIE_SECURE=false → allow cookies over http (development/testing only)
//   COOKIE_SECURE=true  → force secure even outside production
//
// Anything unrecognised falls back to the scheme default, so a typo can never
// silently downgrade a production deployment.

/** Explicit COOKIE_SECURE, or null when unset/blank/unrecognised. */
function explicitCookieSecure(): boolean | null {
  const raw = (process.env.COOKIE_SECURE ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  return null;
}

/**
 * Scheme-free default. Kept for code paths that genuinely have no request
 * (tests, background jobs): production ⇒ secure, everything else ⇒ not.
 */
export function secureCookies(): boolean {
  const explicit = explicitCookieSecure();
  if (explicit !== null) return explicit;
  return process.env.NODE_ENV === 'production';
}

/**
 * The `secure` flag for a cookie set on THIS request.
 *
 * Why this exists: the local stack runs the API image with NODE_ENV=production
 * over http://localhost:8080, so the old NODE_ENV-only rule marked the admin
 * session cookie `Secure` — and Chrome/Firefox/Safari drop such a cookie
 * without any error. The visible result was "Welcome back, admin" followed by
 * an immediate redirect back to the login page, forever.
 *
 * So in production we now mirror the scheme the browser actually used:
 *   * https (Traefik, or any TLS terminator)  → Secure   ✅  unchanged
 *   * plain http (local docker, no TLS)       → not Secure ✅  works
 *
 * `request.protocol` only reflects X-Forwarded-Proto for proxies listed in
 * TRUST_PROXY (see server.ts), so a client that talks to the API directly
 * cannot talk us into marking a production cookie insecure: the socket scheme
 * wins unless the request really came from a configured proxy.
 *
 * Callers that pass no request keep the old, safe-by-default behaviour.
 */
export function cookieSecureFor(request?: { protocol?: string }): boolean {
  const explicit = explicitCookieSecure();
  if (explicit !== null) return explicit;
  if (process.env.NODE_ENV !== 'production') return false;
  if (!request?.protocol) return true; // no scheme information → stay safe
  return request.protocol === 'https';
}

/**
 * True when we are about to hand out a `Secure` session cookie over plain
 * HTTP — i.e. when the browser is guaranteed to throw it away. Used to log an
 * actionable warning instead of letting the operator stare at a login loop.
 */
export function insecureSecureCookieWarning(request?: { protocol?: string }): boolean {
  return cookieSecureFor(request) && request?.protocol === 'http';
}
