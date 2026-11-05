// apps/web/src/app/panel/login/page.tsx — admin login (D-068 polish: show/hide password, brand)
'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { http, rememberCsrf, ApiError } from '../../../lib/api';
import { apiBaseUrl } from '../../../lib/env';
import { notify } from '../../../lib/toast';
import { friendlyAuthError } from '../../../lib/auth-errors';
import { Icon } from '../../../components/admin/ui';
const PLATFORM = process.env.NEXT_PUBLIC_PLATFORM_NAME || '2 Win 2 Play';

function cookieTroubleshoot(reason: 'lost' | 'immediate'): string {
  // Production: friendly message only — no internal COOKIE_SECURE / docker details.
  // Detailed troubleshooting is logged to console for developers only.
  if (typeof window !== 'undefined') {
    console.debug('[panel] session troubleshoot:', {
      reason,
      apiBase: apiBaseUrl(),
      pageHost: window.location.hostname,
    });
  }
  return reason === 'immediate'
    ? 'Your session could not be established. Please try signing in again.'
    : 'Your session has expired. Please sign in again to continue.';
}

/**
 * "Your password was accepted, then the session was closed again *immediately*"
 * is its own failure, not a cookie problem: the API ends a panel session that has
 * been idle longer than `admin_idle_timeout_minutes` (default 60) and refreshes
 * that stamp only if the check already passed. If the account's last-activity
 * stamp came out of a restored database backup (hours old), every login bounces
 * once and the password is blamed. `AUTH_002` is the API telling us exactly that.
 */
function idleSessionHint(): string {
  return 'Your session was closed due to inactivity. Please sign in again. If this keeps happening, please contact support.';
}

/** True only for the auth failures the hint above explains. */
function isSessionLoss(err: unknown): boolean {
  if (err instanceof ApiError) {
    return (
      err.status === 401 ||
      err.status === 403 ||
      err.code === 'AUTH_TOKEN_INVALID' ||
      err.code === 'AUTH_TOKEN_EXPIRED' ||
      err.code === 'AUTH_STEP_UP_REQUIRED'
    );
  }
  return false;
}

export default function PanelLogin() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  // The panel layout sends us here with ?reason=session when its own
  // /panel/auth/me check fails, i.e. the session was lost between page loads.
  // Read it from window rather than useSearchParams: no Suspense boundary is
  // needed and the value never has to be part of the server-rendered HTML.
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('reason');
    if (reason === 'session') setHint(cookieTroubleshoot('lost'));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const session = await http.post<{ token: string; csrfToken?: string }>(
        '/panel/auth/login',
        { username, password }
      );
      rememberCsrf(session.csrfToken);

      // Prove the session survives a round trip BEFORE we navigate. Navigating
      // straight to /panel hid this: the panel then called /panel/auth/me, got a
      // 401 (because the cookie was never stored), and bounced straight back
      // here — an endless "it says welcome and then asks again" loop with no
      // explanation anywhere. One extra request turns that into a clear answer.
      try {
        await http.get<{ username: string; csrfToken?: string }>('/panel/auth/me');
      } catch (probe) {
        // AUTH_002 = "session ended after N minutes of inactivity". Getting it on
        // a session we created a millisecond ago is a stale-activity stamp (a
        // restored database), not a dropped cookie — say so specifically.
        const code = probe instanceof ApiError ? probe.code : undefined;
        setError(
          code === 'AUTH_002'
            ? idleSessionHint()
            : isSessionLoss(probe)
              ? cookieTroubleshoot('immediate')
              : friendlyAuthError(probe)
        );
        return;
      }

      notify.success('Welcome back, admin');
      router.replace('/panel');
      router.refresh();
    } catch (err) {
      // D-103: never show a raw generic "An unexpected error occurred" — map
      // the real failure modes to actionable messages (DB blip during a
      // deploy/restart, timeout, network down, or a traced reference).
      setError(`⚠️ ${friendlyAuthError(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-layer-floor px-6 relative overflow-hidden">
      <div
        className="absolute inset-0 opacity-40"
        style={{
          background:
            'radial-gradient(600px 300px at 20% 10%, rgba(230,184,76,0.10), transparent 60%), radial-gradient(500px 280px at 85% 90%, rgba(59,130,246,0.08), transparent 60%)',
        }}
      />
      <div className="w-full max-w-sm relative">
        <div className="text-center mb-8">
          <img
            src="/icons/logo.svg"
            alt={PLATFORM}
            className="w-20 h-20 mx-auto mb-4 drop-shadow-[0_8px_24px_rgba(245,200,66,0.25)]"
          />
          <p className="t-title text-gold">{PLATFORM}</p>
          <p className="t-label-md text-secondary mt-1">Admin Console</p>
          <p className="t-label-sm text-muted mt-2">
            Restricted area — authorized staff only
          </p>
        </div>
        <form
          onSubmit={submit}
          className="rounded-2xl bg-layer-surface border border-white/8 p-6 space-y-4 shadow-2xl"
        >
          <div>
            <label className="t-label-sm text-secondary block mb-1.5">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              autoComplete="username"
              autoFocus
              className="w-full h-12 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none focus:border-gold/40"
            />
          </div>
          <div>
            <label className="t-label-sm text-secondary block mb-1.5">Password</label>
            <div className="relative">
              <input
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full h-12 px-3 pr-11 rounded-lg bg-layer-elevated border border-white/10 outline-none focus:border-gold/40"
              />
              <button
                type="button"
                onClick={() => setShow(!show)}
                aria-label="Toggle password visibility"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80"
              >
                <Icon name="eye" size={17} />
              </button>
            </div>
          </div>
          {error && (
            <p className="t-label-sm text-red bg-red/10 border border-red/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          {hint && !error && (
            <p className="t-label-sm text-gold bg-gold/10 border border-gold/25 rounded-lg px-3 py-2">
              {hint}
            </p>
          )}
          <button
            disabled={!username || !password || loading}
            className="btn-gold w-full h-12 disabled:opacity-50"
          >
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <span className="h-4 w-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />{' '}
                Signing in…
              </span>
            ) : (
              'Sign In'
            )}
          </button>
        </form>
        <p className="text-center t-label-sm text-muted mt-6">
          © {new Date().getFullYear()} {PLATFORM} — all admin actions are audited
        </p>
      </div>
    </div>
  );
}
