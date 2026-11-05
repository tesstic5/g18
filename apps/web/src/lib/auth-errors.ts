// apps/web/src/lib/auth-errors.ts — D-103: friendly, actionable error messages
// for login/signup (player + admin). Never show a raw "An unexpected error
// occurred": map DB-unavailable (503 during restarts), timeouts, network
// failures, and generic 500s (with a traceable ref) to clear guidance.
export interface AuthLikeError {
  code?: string;
  status?: number;
  message?: string;
  details?: { requestId?: string };
}

export function friendlyAuthError(err: unknown): string {
  const e = (err ?? {}) as AuthLikeError;
  const ref = e.details?.requestId;
  const msg = e.message || '';

  if (e.code === 'AUTH_001') return 'Incorrect phone number or password';
  if (e.code === 'AUTH_008')
    return 'This phone number is already registered — try logging in';
  if (e.code === 'REF_INVALID') return 'That referral code is not valid';
  if (e.code === 'GEN_003') return msg || 'Too many attempts — please try again later';
  if (e.code === 'CORS_DENIED') {
    return 'Your browser was blocked by the server\u2019s security settings — this usually means the site is configured for a different address. Please try a hard refresh (Ctrl+Shift+R) or contact support.';
  }
  if (
    e.code === 'GEN_004' ||
    e.code === 'GEN_TIMEOUT' ||
    e.status === 503 ||
    e.code === 'SVC_503'
  ) {
    return 'Service is temporarily unavailable — the server is starting up or restarting. Please try again in a moment.';
  }
  // network-level failure (fetch rejected — no status/code from the API)
  if (!e.status && !e.code)
    return 'Can\u2019t reach the server — check your internet connection and try again';
  // anything else: show the real message unless it's the masked generic 500
  if (msg && !/unexpected error/i.test(msg)) return msg;
  return `Something went wrong on our side${ref ? ` (ref: ${ref})` : ''} — please try again in a moment.`;
}
