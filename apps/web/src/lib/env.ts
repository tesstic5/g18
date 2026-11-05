// apps/web/src/lib/env.ts — runtime resolution of API/WS endpoints.
//
// Order of resolution:
//   1. Explicit NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL (set in prod deploys,
//      e.g. https://api.yourbrand.com/api/v1).
//   2. Sandbox live preview: the browser page is served from
//      https://3000-{sandboxId}.e2b.app and the API lives on the sibling
//      preview https://4000-{sandboxId}.e2b.app. The browser can NEVER reach
//      localhost, so we derive the sibling origin from window.location.
//   3. Same-origin fallback ('' + relative path) — used in prod behind nginx
//      and local dev on the same host.
export function apiBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_API_URL;
  if (explicit) return explicit;
  if (typeof window === 'undefined') return '/api/v1';
  const m = window.location.host.match(/^3000-(.+)$/);
  if (m) return `https://4000-${m[1]}/api/v1`;
  return '/api/v1';
}

export function wsBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit;
  if (typeof window === 'undefined') return '';
  const m = window.location.host.match(/^3000-(.+)$/);
  if (m) return `https://4000-${m[1]}`;
  return '';
}
