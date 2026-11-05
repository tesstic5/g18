// apps/api/src/lib/origins.ts — D-104: robust CORS origin matching for the API.
// Production CORS used to be an EXACT string match on FRONTEND_URL — a trailing
// slash, an http↔https mismatch, or a www prefix silently rejected real browser
// requests ("Not allowed by CORS" → 500 on every auth call). This normalizes
// both sides so the legitimate variants of the site always pass while foreign
// origins stay blocked.
//
// D-105: loopback origins (localhost / 127.0.0.1 / [::1]) are accepted on ANY
// port. The allowlist used to hardcode :3000 and :4000, so the moment the web
// container was published on a different host port — `WEB_HOST_PORT=8080`, the
// default in docker-compose.yml — every login POST was rejected with
// CORS_DENIED and the UI showed "Your browser was blocked by the server's
// security settings". Being port-coupled to the dev setup was the bug; the host
// part is what carries risk, and a loopback host is not reachable from the
// internet.
//
// Why this is safe in production: a browser can only send an Origin it is
// actually running on, and no public page can claim `localhost`. A page served
// by local software cannot ride an admin session either, because the session
// cookies are SameSite=Lax and therefore not attached to cross-site requests
// (localhost → 2win2play.com is cross-site). Auth still has to satisfy the
// double-submit CSRF check, so a loopback origin grants no privileges.

export function normalizeOrigin(o?: string | null): string {
  return (o ?? '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '');
}

// Hostname only (no scheme, no port). Handles bare "localhost:8080" too, which
// is not a valid URL on its own.
export function hostnameOf(o?: string | null): string {
  const raw = (o ?? '').trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(withScheme).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackOrigin(origin?: string | null): boolean {
  return LOOPBACK_HOSTS.has(hostnameOf(origin));
}

export function isOriginAllowed(
  origin: string | undefined | null,
  frontendUrl?: string
): boolean {
  // No Origin header = same-origin proxied request / curl / server-to-server → allow
  if (!origin) return true;
  // Fail closed: without FRONTEND_URL there is no configured site to trust.
  if (!frontendUrl) return false;
  // Any local address, any port — DEV ONLY (see the D-105 note above). In
  // production a loopback Origin must come from the configured FRONTEND_URL
  // match below: no public page can claim localhost, but any locally running
  // software can, so the permissive loopback rule is disabled when NODE_ENV=production.
  if (isLoopbackOrigin(origin) && process.env.NODE_ENV !== 'production') return true;
  return normalizeOrigin(origin) === normalizeOrigin(frontendUrl);
}
