// apps/web/src/components/GameShell.tsx — every game wrapper (v4 SHARED GAME COMPONENTS)
'use client';
import React, { useState } from 'react';
import { useUIStore, useAuthStore } from '../stores';
import { http } from '../lib/api';
import { ErrorBoundary, BetHistory, NotificationBell } from './ui';
import { useAppLifecycle, useMultiTab } from '../hooks';

interface GameShellProps {
  slug: string;
  title: string;
  children: React.ReactNode; // the game visual (top ~60%)
  betPanel: React.ReactNode; // the bet controls (bottom ~40%)
  showLiveFeed?: boolean;
  onRulesOpen?: () => void;
  rules?: {
    description?: string | null;
    baseRtp?: number;
    minBet?: number;
    maxWinMultiplier?: number;
  } | null;
  demo?: {
    active: boolean;
    balance: number;
    onReset: () => void;
    signedIn: boolean;
    onExit?: () => void;
  };
}

/** 100dvh viewport lock (docs/18) + header bar (docs/18 TOP BAR) + history tabs. */
export function GameShell({
  slug,
  title,
  children,
  betPanel,
  onRulesOpen,
  rules,
  demo,
}: GameShellProps) {
  const { soundEnabled, toggleSound } = useUIStore();
  // M-18: the star used to flip a LOCAL boolean that vanished on reload — it
  // never called /user/favorites. Signed-in players persist to their account;
  // guests keep the visual-only star.
  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);
  const [favLocal, setFavLocal] = useState(false);
  const fav = user ? (user.favorites?.includes(slug) ?? false) : favLocal;
  const toggleFav = () => {
    if (!user) {
      setFavLocal((f) => !f);
      return;
    }
    const current = user.favorites ?? [];
    const next = fav ? current.filter((x) => x !== slug) : [...current, slug];
    // optimistic — revert on rejection
    useAuthStore.getState().setSession({ ...user, favorites: next }, accessToken);
    http
      .patch('/user/favorites', { gameSlugs: next })
      .catch(() => useAuthStore.getState().setSession(user, accessToken));
  };
  const [pfOpen, setPfOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const isDuplicate = useMultiTab(slug);
  useAppLifecycle(true);

  return (
    <ErrorBoundary>
      <div className="game-page" data-theme="dark">
        {/* TOP BAR — 56px fixed (docs/18) */}
        {/* v1.3.8: px-4→px-2 on phones buys ~16px for the right cluster;
            the title is NO LONGER absolutely centered below sm — absolute-
            centered titles slid UNDER the ever-growing right cluster (the
            overlap the user screenshotted). Now it flows, truncates with
            ellipsis, and only recenters from 640px up. */}
        <header className="top-bar flex items-center justify-between px-2 sm:px-4 h-14 border-b border-white/5 bg-layer-floor z-100 gap-1">
          <button
            aria-label="Back"
            className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 flex items-center justify-center active:scale-92 transition-transform"
            onClick={() => history.back()}
          >
            ‹
          </button>
          <h1 className="t-label-xl text-primary min-w-0 truncate flex-1 sm:flex-none sm:absolute sm:left-1/2 sm:-translate-x-1/2 sm:max-w-[42vw] sm:text-center">
            {title}
          </h1>
          <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
            <button
              aria-label="Favorites"
              onClick={toggleFav}
              className={`w-9 h-9 sm:w-10 sm:h-10 ${fav ? 'text-gold' : 'text-white/50'}`}
            >
              ☆
            </button>
            <button
              aria-label="Sound"
              onClick={toggleSound}
              className="w-9 h-9 sm:w-10 sm:h-10 text-white/50"
            >
              {soundEnabled ? '🔊' : '🔇'}
            </button>
            <button
              aria-label="Rules"
              onClick={() => {
                if (onRulesOpen) onRulesOpen();
                setRulesOpen(true);
              }}
              className="w-9 h-9 sm:w-10 sm:h-10 text-white/50"
            >
              ?
            </button>
            <button
              aria-label="Verify"
              onClick={() => setPfOpen(true)}
              className="t-mono text-gold/80 px-1 sm:px-2"
            >
              ✓
            </button>
            {/* D-091: notification bell in the GAME navbar — the player shell's
                bell is hidden on game routes so there is exactly one bell here.
                Guests in demo mode see the log-in CTA instead of a dead bell. */}
            {!demo?.active || demo?.signedIn ? <NotificationBell /> : null}
            <BalanceChip demoBalance={demo?.active ? demo.balance : undefined} />
          </div>
        </header>

        {/* DEMO BANNER (docs/20 §9) — virtual coins notice */}
        {demo?.active && (
          <div className="flex items-center justify-between gap-2 px-4 py-2 bg-gold/10 border-b border-gold/20">
            <p className="t-label-sm text-gold">
              ⚡ Demo Mode — playing with virtual coins
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                className="t-label-sm text-white/60 underline"
                onClick={demo.onReset}
              >
                Reset
              </button>
              {demo.signedIn && demo.onExit && (
                <button
                  className="t-label-sm text-white/60 underline"
                  onClick={demo.onExit}
                >
                  Exit demo
                </button>
              )}
              {!demo.signedIn && (
                <>
                  <a href="/signup" className="t-label-sm text-green underline">
                    Sign up
                  </a>
                  <a href="/login" className="t-label-sm text-gold underline">
                    Log in
                  </a>
                </>
              )}
            </div>
          </div>
        )}

        {/* Multi-tab warning overlay (docs/20 §15) */}
        {isDuplicate && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70">
            <div className="bg-layer-elevated rounded-lg p-4 max-w-xs border border-gold/25">
              <p className="t-label-lg text-primary mb-2">
                ⚠️ Game Open in Another Tab
              </p>
              <p className="t-body text-secondary mb-4">
                Using multiple tabs may cause unexpected behavior.
              </p>
              <button className="btn-primary w-full" onClick={() => location.reload()}>
                Play Here
              </button>
            </div>
          </div>
        )}

        {/* GAME CANVAS — responsive, fills width, scales with viewport (D-064) */}
        {/* GAME CANVAS — responsive: content scales to fit the viewport (D-087) */}
        <main className="game-canvas relative flex-1 min-h-0 px-3 py-3 overflow-hidden">
          {/* layered backdrop behind every game */}
          <div className="absolute inset-3 rounded-2xl overflow-hidden border border-white/8 bg-[radial-gradient(120%_90%_at_50%_0%,rgba(245,200,66,0.10),transparent_55%),radial-gradient(90%_70%_at_85%_100%,rgba(77,159,255,0.10),transparent_60%),linear-gradient(160deg,#12121c,#0a0a12)]">
            {/* subtle grid */}
            <div
              className="absolute inset-0 opacity-[0.35]"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)',
                backgroundSize: '28px 28px',
              }}
            />
            {/* floating orbs */}
            <div className="absolute -top-10 -left-10 w-40 h-40 rounded-full bg-gold/10 blur-3xl animate-float-slow" />
            <div className="absolute -bottom-12 -right-8 w-48 h-48 rounded-full bg-blue-500/10 blur-3xl animate-float-slower" />
            {/* game visual — centered, scales to fit */}
            <div className="absolute inset-0 flex items-center justify-center p-2 sm:p-4">
              <div className="w-full h-full flex items-center justify-center">
                {children}
              </div>
            </div>
          </div>
        </main>

        {/* BET CONTROLS — floating panel (docs/18) */}
        <section className="game-controls bg-layer-surface border-t border-white/5 rounded-t-2xl px-4 pt-4 pb-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          {betPanel}
        </section>

        {/* HISTORY TABS — 180–200px internal scroll (docs/18) */}
        <BetHistory slug={slug} showLiveFeed />

        {/* RULES MODAL (docs/16 §9 — description, RTP, min/max) */}
        {rulesOpen && (
          <div
            className="fixed inset-0 z-100 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center"
            onClick={() => setRulesOpen(false)}
          >
            <div
              className="bg-layer-elevated w-full sm:max-w-md rounded-t-2xl sm:rounded-lg p-6 max-h-[80dvh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="t-label-xl text-primary mb-2">How to play {title}</h2>
              <p className="t-body text-secondary mb-4">
                {rules?.description ||
                  `${title} is a provably-fair game. Every outcome is determined server-side and verifiable.`}
              </p>
              {rules && (
                <dl className="space-y-2 mb-4">
                  <div className="flex justify-between">
                    <dt className="t-label-md text-secondary">
                      Return to Player (RTP)
                    </dt>
                    <dd className="t-num-md text-gold">
                      {Number(rules.baseRtp ?? 0).toFixed(2)}%
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="t-label-md text-secondary">Min bet</dt>
                    <dd className="t-num-md text-primary">
                      {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
                      {Number(rules.minBet ?? 0).toFixed(2)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="t-label-md text-secondary">Max win multiplier</dt>
                    <dd className="t-num-md text-primary">
                      {Number(rules.maxWinMultiplier ?? 0).toFixed(0)}×
                    </dd>
                  </div>
                </dl>
              )}
              <p className="t-body text-secondary text-sm mb-4">
                Provably fair: the server commits a seed hash before you bet; after
                rotation the seed is revealed and any round can be verified at
                /provably-fair.
              </p>
              <button
                className="btn-primary w-full"
                onClick={() => setRulesOpen(false)}
              >
                Got it
              </button>
            </div>
          </div>
        )}

        {/* Provably fair modal */}
        {pfOpen && (
          <div
            className="fixed inset-0 z-100 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center"
            onClick={() => setPfOpen(false)}
          >
            <div
              className="bg-layer-elevated w-full sm:max-w-md rounded-t-2xl sm:rounded-lg p-6 max-h-[85dvh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="t-label-xl text-primary mb-2">Provably Fair</h2>
              <p className="t-body text-secondary mb-4">
                Every round is verifiable: hash the revealed server seed, recompute
                HMAC-SHA256(serverSeed, clientSeed:nonce) and compare with the stored
                raw outcome.
              </p>
              <a href="/provably-fair" className="btn-primary w-full text-center">
                Open Verifier
              </a>
            </div>
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}

/** Balance chip (docs/18 WALLET BALANCE CHIP) — tappable → wallet (login first if signed out; demo → virtual) */
function BalanceChip({ demoBalance }: { demoBalance?: number }) {
  const real = useWalletBalance();
  const user = useAuthStore((s) => s.user);
  // demo runs through the same hold correction (demoStore deducts/credits at
  // exactly the same lifecycle points as the real wallet).
  const holds = useBalanceHolds((s) => s.holds);
  const balance =
    demoBalance !== undefined ? demoBalance + balanceCorrection(holds) : real;
  const isDemo = demoBalance !== undefined;
  return (
    <button
      onClick={() => {
        if (isDemo) return;
        window.location.href = user
          ? '/wallet'
          : `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
      }}
      className="balance-chip flex items-center gap-1 rounded-full px-2 sm:px-3 h-9 bg-gold/10 border border-gold/20"
    >
      <span className="text-gold/80 text-xs sm:text-sm">
        {isDemo ? '✦' : process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
      </span>
      <span className="t-num-hd text-gold">{(Number(balance) || 0).toFixed(2)}</span>
    </button>
  );
}
import { useWalletStore, useBalanceHolds, balanceCorrection } from '../stores';
function useWalletBalance() {
  const b = useWalletStore();
  const holds = useBalanceHolds((s) => s.holds);
  // D-084: total playable balance (bonus included); holds keep the number
  // still while a round runs — it moves only when the result announces.
  return (
    (Number(b.real) || 0) +
    (Number(b.bonus) || 0) +
    (Number(b.gifted) || 0) +
    balanceCorrection(holds)
  );
}
