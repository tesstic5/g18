// apps/web/src/app/providers.tsx — QueryClient + theme + session restore + socket (docs/22 §fetch)
'use client';
import React, { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient, socket, connectSocket } from '../lib/app';
import { useAuthStore, useUIStore, refreshBalance } from '../stores';
import { apiBaseUrl } from '../lib/env';
import { rememberCsrf } from '../lib/api';

// ── D-101: WHITE-SCREEN AUTO-HEAL ──────────────────────────────────────────
// A chunk load failure (stale service-worker cache after a deploy, corrupted
// cache, partial build) makes React fail to hydrate — and that error happens
// OUTSIDE the React error boundary, so the page is just... white. Detect the
// classic chunk-failure signatures and reload ONCE with a cache-busting query
// (fresh=timestamp forces the SW's network-first handler to skip the cache).
let healArmed = false;
function armWhiteScreenHeal(): void {
  if (healArmed || typeof window === 'undefined') return;
  healArmed = true;
  const KEY = '2w2p-chunk-retry';
  const isChunkFailure = (msg: string): boolean =>
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Loading chunk .* failed/i.test(msg) ||
    /Loading CSS chunk .* failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg) ||
    /Importing a module script failed/i.test(msg);
  const heal = (): void => {
    try {
      if (sessionStorage.getItem(KEY)) return; // already retried once this session
      sessionStorage.setItem(KEY, '1');
      const sep = window.location.search ? '&' : '?';
      window.location.replace(
        `${window.location.pathname}${window.location.search}${sep}fresh=${Date.now()}`
      );
    } catch {
      window.location.reload();
    }
  };
  window.addEventListener('error', (e) => {
    if (isChunkFailure(e.message || '')) heal();
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e.reason as Error | undefined)?.message ?? String(e.reason ?? '');
    if (isChunkFailure(reason)) heal();
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const theme = useUIStore((s) => s.theme);

  useEffect(() => {
    // D-101: arm the white-screen auto-heal as early as possible (before any
    // lazy chunk of the app is requested).
    armWhiteScreenHeal();
    // PWA service worker (docs/19 §12). D-075: skipped in development — dev
    // chunks change on every restart and a SW would serve stale ones (caused
    // "This page couldn't load" crashes). In dev we also actively UNREGISTER
    // any leftover SW from earlier sessions. In production: updateViaCache
    // none so the browser always revalidates sw.js (versioned cache wipes
    // old chunks after every deploy).
    try {
      if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
      if (process.env.NODE_ENV !== 'production') {
        void navigator.serviceWorker
          .getRegistrations()
          .then((regs) => regs.forEach((r) => void r.unregister()))
          .catch(() => {});
        return;
      }
      if (window.isSecureContext) {
        navigator.serviceWorker
          .register('/sw.js', { updateViaCache: 'none' })
          .then((reg) => {
            void reg.update();
          })
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
    useUIStore.getState().setTheme('dark');

    // D-091 + D-099: the socket stays connected at all times (guests too — the
    // server now accepts anonymous viewers so live crash/wingo rounds are
    // visible without logging in). When the access token CHANGES (login or
    // logout), reconnect so the server associates the socket with the new
    // identity (user rooms for notifications/balance/deposit/chat).
    const unsubAuth = useAuthStore.subscribe((s, prev) => {
      if (s.accessToken !== prev.accessToken) {
        socket.disconnect();
        connectSocket();
      }
    });

    // ── SESSION RESTORE (D-071 + D-096 FIX) ────────────────────────────────
    // The refresh token lives in an httpOnly cookie (7 days). On every page
    // load we try to trade it for a fresh access token so the user STAYS
    // logged in across reloads.
    //
    // D-096: the restore is a MODULE-LEVEL SINGLETON. Before, it lived inline
    // in the effect: React StrictMode (dev) mounts the effect twice — the
    // first mount's async refresh completed AFTER its cleanup had set
    // `cancelled=true` (token discarded), while the second mount's concurrent
    // refresh hit the ALREADY-ROTATED refresh cookie → 401 → the user landed
    // as a guest on ~50% of page loads (flaky login). The singleton runs the
    // restore exactly once per page load, regardless of StrictMode.
    runSessionRestore();

    return () => {
      unsubAuth();
      socket.disconnect();
    };
  }, [theme]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

// ── D-096: module-level singleton session restore ─────────────────────────
// Runs exactly ONCE per page load (survives React StrictMode's double-mount
// and any re-render), so the refresh cookie is only ever traded once — no
// rotation race, no cancelled-flag race. If the refresh returns 401 (a
// concurrent caller may have rotated the cookie first), retry once — the
// rotated cookie is then valid.
//
// D-100: the restore must NOT give up on one hiccup. Before, `hydrated` was
// set to true right after the refresh (before /auth/me) and a single failing
// /auth/me left the app in "guest" state while the user WAS logged in —
// "games don't know a user is logged in… then refresh fixes it". Now:
//  - `hydrated` stays FALSE until /auth/me succeeds (UI shows a loading
//    state instead of a wrong login/guest state),
//  - /auth/me is retried (3×, backoff) and, on 401, the refresh cookie is
//    re-traded (another tab may have rotated it) before retrying,
//  - only after ALL attempts fail do we settle as guest.
let restoreStarted = false;
function runSessionRestore(): void {
  if (restoreStarted) return;
  restoreStarted = true;
  void (async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const BASE = apiBaseUrl();

    // trade the refresh cookie for an access token (retry once on rotation)
    let res = await fetch(`${BASE}/auth/refresh-token`, {
      method: 'POST',
      credentials: 'include',
    });
    if (res.status === 401 || res.status === 409) {
      if (res.status === 409) await sleep(150);
      res = await fetch(`${BASE}/auth/refresh-token`, {
        method: 'POST',
        credentials: 'include',
      });
    }
    const json = (await res.json().catch(() => null)) as {
      data?: { accessToken?: string };
    } | null;
    let accessToken = res.ok ? json?.data?.accessToken : undefined;

    if (accessToken) {
      // D-100: hold `hydrated` FALSE until the profile actually loads, so the
      // app never flashes "Log in to play" for a logged-in user.
      useAuthStore.setState({ accessToken, hydrated: false });
      connectSocket();

      // hydrate the profile — raw fetch (no api() wrapper so its own 401 →
      // refresh side-effects can't interfere with the retry logic)
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const meRes = await fetch(`${BASE}/auth/me`, {
            credentials: 'include',
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (meRes.ok) {
            const me = (await meRes.json().catch(() => null)) as {
              data?: {
                id: string;
                displayName?: string;
                phone: string;
                language?: string;
                theme?: string;
                sessionReminderMin?: number | null;
                dailyLossLimit?: number | string | null;
                dailyDepositLimit?: number | string | null;
                selfExcludedUntil?: string | null;
                favorites?: string[];
                csrfToken?: string;
              };
            } | null;
            if (me?.data) {
              rememberCsrf(meRes.headers.get('x-csrf-token') || me.data.csrfToken);
              useAuthStore.getState().setSession(me.data, accessToken);
              void refreshBalance().catch(() => {});
              return; // fully hydrated as the user
            }
          } else if (meRes.status === 401) {
            // token may have been rotated by another tab → re-trade the cookie
            let rr = await fetch(`${BASE}/auth/refresh-token`, {
              method: 'POST',
              credentials: 'include',
            });
            if (rr.status === 409) {
              await sleep(150);
              rr = await fetch(`${BASE}/auth/refresh-token`, {
                method: 'POST',
                credentials: 'include',
              });
            }
            const rj = (await rr.json().catch(() => null)) as {
              data?: { accessToken?: string };
            } | null;
            if (rr.ok && rj?.data?.accessToken) {
              accessToken = rj.data.accessToken;
              useAuthStore.setState({ accessToken, hydrated: false });
              continue;
            }
          }
        } catch {
          /* transient — retry */
        }
        if (attempt < 2) await sleep(400 * (attempt + 1));
      }
    }

    // D-099: guests connect the socket too (anonymous viewer) so live rounds
    // are visible — the socket no longer requires a token.
    connectSocket();
    useAuthStore.setState({ hydrated: true }); // settled as guest (D-067)
  })();
}
