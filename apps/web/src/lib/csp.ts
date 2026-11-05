// apps/web/src/lib/csp.ts — nonce-based Content-Security-Policy.
// Scripts: nonce + strict-dynamic. 'unsafe-inline' is IGNORED by browsers once
// a nonce is present, and we do not emit it for script-src.
// Styles: 'unsafe-inline' remains — Next/font and Tailwind inject style tags
// that cannot carry a per-request nonce without a full CSS pipeline rewrite.

/**
 * Browser-reachable API/WS origins that the scheme sources below do NOT cover.
 *
 * `https:` / `wss:` / `ws:` cover every production deployment (the API is TLS
 * behind nginx) and Socket.IO. They do NOT cover a **plain-http** API — which is
 * exactly what `docker-compose.yml` serves locally (`http://localhost:4000`).
 * With no `http:` source in connect-src the browser refuses the request before
 * it leaves the page ("Refused to connect … violates Content Security Policy"),
 * so EVERY /auth/login fetch failed. The client rewrites that failed fetch to
 * GEN_TIMEOUT, which the UI shows as "Service is temporarily unavailable" —
 * i.e. a CSP bug that looked like an outage, while `curl` (no CSP) worked fine.
 *
 * Fix: allow localhost/127.0.0.1 on any port (dev only, ignored by prod
 * policies) plus the exact origin of any http-scheme API/WS build arg. An
 * https API adds nothing new — `https:` already covers it.
 */
function extraConnectSources(): string[] {
  const out = ['http://localhost:*', 'http://127.0.0.1:*'];
  for (const raw of [process.env.NEXT_PUBLIC_API_URL, process.env.NEXT_PUBLIC_WS_URL]) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:') out.push(url.origin);
    } catch {
      /* malformed build arg — ignore */
    }
  }
  return out;
}

export function buildCsp(nonce: string): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // wss:/https:/ws: cover Socket.IO, the API, and S3_PUBLIC_ENDPOINT whose
    // hosts are operator-configured and not known at build time.
    // extraConnectSources() adds the plain-http origins a LOCAL stack uses.
    ["connect-src 'self' wss: https: ws:", ...extraConnectSources()].join(' '),
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ];
  return directives.join('; ');
}
