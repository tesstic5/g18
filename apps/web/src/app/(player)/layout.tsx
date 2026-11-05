// apps/web/src/app/(player)/layout.tsx — main player shell (docs/18: top bar, ticker, bottom nav)
'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { socket } from '../../lib/app';
import { http } from '../../lib/api';
import {
  useWalletStore,
  useAuthStore,
  useBalanceHolds,
  balanceCorrection,
} from '../../stores';
import { NotificationBell } from '../../components/ui';
import { ChatWidget } from '../../components/support/ChatWidget';
import { t, detectLang } from '../../lib/i18n';
import { notify } from '../../lib/toast';

export default function PlayerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const logout = useAuthStore((s) => s.logout);
  const lang = detectLang(user?.language);
  const [balance] = useBalance();
  // D-084: show TOTAL playable balance (real + bonus + gifted) so bonus
  // claims and rewards are visible immediately.
  // Balance-hold rule: the number ONLY moves when a result is announced —
  // useBalanceHolds adds back the stake of any bet still awaiting its
  // announce (and stubs out credited-but-unannounced payouts).
  const holds = useBalanceHolds((s) => s.holds);
  const totalBalance =
    (Number(balance.real) || 0) +
    (Number(balance.bonus) || 0) +
    (Number(balance.gifted) || 0) +
    balanceCorrection(holds);
  const [menuOpen, setMenuOpen] = useState(false);

  // Responsible-play session reminder. This follows the player's persisted
  // choice and continues across route changes while the app is open.
  useEffect(() => {
    const minutes = Number(user?.sessionReminderMin ?? 0);
    if (!user || !Number.isFinite(minutes) || minutes <= 0) return;
    const timer = window.setInterval(() => {
      notify.info(
        `You have been playing for another ${minutes} minutes. Consider taking a break and review your spend.`
      );
    }, minutes * 60_000);
    return () => window.clearInterval(timer);
  }, [user, user?.sessionReminderMin]);

  // D-096: game pages own the ENTIRE viewport — the shell header, big-win
  // ticker, bottom nav and chat bubble are hidden on /games/[slug] because the
  // game page has its own top bar (GameShell) and 100dvh lock. Previously the
  // shell chrome (header 56 + ticker 36 + nav 60) sat ON TOP of the 100dvh
  // game page, covering the bottom ~116px (the whole game-history section).
  const isGamePage = pathname.startsWith('/games/');

  const MENU: Array<[string, string, string]> = [
    ['/', '⌂', 'Home'],
    ['/games', '▦', 'Games'],
    ['/wallet', '◈', 'Wallet'],
    ['/bonuses', '✦', 'Bonuses'],
    ['/referral', '🎁', 'Referral'],
    ['/leaderboard', '🏆', 'Leaderboard'],
    ['/provably-fair', '✓', 'Provably Fair'],
    ['/support', '💬', 'Support'],
    ['/profile', '◎', 'Profile'],
  ];

  return (
    <div className="min-h-dvh flex flex-col bg-layer-floor">
      {/* TOP BAR — 56px (docs/18); 3-col grid so the brand truncates instead of
          overlapping the bell/balance on narrow screens (D-060). Hidden on
          game pages (D-096) — GameShell has its own top bar. */}
      {!isGamePage && (
        <header className="top-bar sticky top-0 z-100 h-14 flex items-center justify-between px-2 sm:px-4 bg-layer-floor border-b border-white/5">
          {/* Hamburger — opens the slide-in menu (was a dead button — fixed) */}
          <button
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
            className="w-10 h-10 shrink-0 flex flex-col items-center justify-center gap-1 active:scale-90"
          >
            <span className="w-[18px] h-0.5 bg-white/80" />
            <span className="w-[18px] h-0.5 bg-white/80" />
            <span className="w-[18px] h-0.5 bg-white/80" />
          </button>

          {/* Brand — logo + name; always goes to the homepage/lobby; truncates on small screens */}
          <Link
            href="/"
            aria-label="2 Win 2 Play — go to homepage"
            className="min-w-0 flex-1 flex justify-center items-center gap-2 px-1 active:opacity-70"
          >
            <img
              src="/icons/wordmark.png"
              alt="2 Win 2 Play"
              className="h-7 sm:h-8 w-auto max-w-[38vw] sm:max-w-[260px] object-contain"
            />
          </Link>

          <div className="flex items-center gap-1 shrink-0">
            {!hydrated ? (
              /* D-100: session restoring — neutral chip instead of a wrong
               "Log in" button for a logged-in user */
              <div className="h-9 w-24 rounded-full bg-white/5 border border-white/10 flex items-center justify-center gap-1.5 px-3">
                <span className="inline-block w-3 h-3 border-2 border-white/15 border-t-gold rounded-full animate-spin" />
              </div>
            ) : user ? (
              <>
                {/* D-091: on game pages the bell lives in the game navbar
                  (GameShell) — showing it here too would double it */}
                {!pathname.startsWith('/games/') && <NotificationBell />}
                {/* Balance chip (docs/18) — gold pill; tap → wallet */}
                <Link
                  href="/wallet"
                  aria-label="Wallet"
                  className="balance-chip flex items-center gap-1 rounded-full px-2 sm:px-3 h-9"
                >
                  <span className="text-gold/80 text-xs sm:text-sm">
                    {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
                  </span>
                  <span className="t-num-hd text-gold">
                    {(Number(totalBalance) || 0).toFixed(2)}
                  </span>
                </Link>
              </>
            ) : (
              /* D-072: guests see a Log in button instead of a fake ₨0.00 balance */
              <Link
                href={`/login?redirect=${encodeURIComponent(pathname)}`}
                className="btn-outline-gold h-9 px-4 rounded-full"
              >
                Log in
              </Link>
            )}
          </div>
        </header>
      )}

      {/* NAV DRAWER (hamburger menu) */}
      {menuOpen && (
        <div className="fixed inset-0 z-[130]">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setMenuOpen(false)}
          />
          <aside className="absolute left-0 top-0 h-full w-[280px] max-w-[85vw] bg-layer-elevated border-r border-white/10 flex flex-col overflow-y-auto">
            {/* user block */}
            <div className="p-4 border-b border-white/8">
              {user ? (
                <>
                  <p className="t-label-xl text-primary truncate">
                    {user.displayName || 'Player'}
                  </p>
                  <p className="t-label-sm text-muted">{user.phone}</p>
                </>
              ) : (
                <div className="flex gap-2">
                  <Link href="/login" className="btn-primary flex-1 h-10">
                    Log in
                  </Link>
                  <Link href="/signup" className="btn-outline-gold flex-1 h-10">
                    Sign up
                  </Link>
                </div>
              )}
            </div>

            {/* nav items */}
            <nav className="flex-1 p-2 space-y-0.5">
              {MENU.map(([href, icon, label]) => {
                const active =
                  pathname === href ||
                  (href === '/games' && pathname.startsWith('/games/'));
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setMenuOpen(false)}
                    className={`flex items-center gap-3 px-3 h-11 rounded-lg t-label-md ${active ? 'bg-gold/10 text-gold' : 'text-white/70 hover:bg-white/5'}`}
                  >
                    <span className="text-lg w-6 text-center">{icon}</span>
                    {label}
                  </Link>
                );
              })}
            </nav>

            {/* footer actions */}
            <div className="p-3 border-t border-white/8 space-y-2">
              {user && (
                <button onClick={logout} className="btn-danger w-full h-10">
                  Log out
                </button>
              )}
              <p className="t-label-sm text-muted text-center">v0.1.0</p>
            </div>
          </aside>
        </div>
      )}

      {/* BIG WIN TICKER (docs/18) — marquee fed by lobby:big-win. Hidden on
          game pages (D-096) so the game owns the full viewport. */}
      {!isGamePage && <BigWinTicker />}

      <main className="flex-1">{children}</main>

      {/* Bottom nav (docs/18) — 5 items, gold active indicator. Hidden on game
          pages (D-096) — the game page has its own back button and needs the
          full height; this was covering the bottom ~116px of every game. */}
      {!isGamePage && (
        <nav className="bottom-nav sticky bottom-0 z-100 h-[60px] bg-layer-surface border-t border-white/5 grid grid-cols-5">
          {(
            [
              ['/', 'home'],
              ['/games', 'games'],
              ['/wallet', 'wallet'],
              ['/bonuses', 'bonuses'],
              ['/profile', 'profile'],
            ] as const
          ).map(([href, key]) => {
            const active =
              pathname === href ||
              (href === '/games' && pathname.startsWith('/games/'));
            return (
              <Link
                key={href}
                href={href}
                className="flex flex-col items-center justify-center gap-1 relative"
              >
                {active && (
                  <span className="absolute top-0 w-[3px] h-6 bg-gold rounded-b" />
                )}
                <span
                  className={`text-[22px] leading-none ${active ? 'text-gold drop-shadow-[0_0_6px_rgba(245,200,66,0.5)]' : 'text-white/55'}`}
                >
                  {icons[key]}
                </span>
                <span
                  className={`t-label-sm ${active ? 'text-gold' : 'text-white/55'}`}
                >
                  {t(lang, `nav.${key}`)}
                </span>
              </Link>
            );
          })}
        </nav>
      )}

      {/* Support chat widget (draggable bubble + compact panel). Hidden on game
          pages (D-096) so it never floats over the bet controls. */}
      {!isGamePage && <ChatWidget />}
    </div>
  );
}

const icons: Record<string, string> = {
  home: '⌂',
  games: '▦',
  wallet: '◈',
  bonuses: '✦',
  profile: '◎',
};

function useBalance(): [
  { real: number; bonus: number; gifted: number; locked: number },
  (b: { real: number; bonus: number; gifted: number; locked: number }) => void,
] {
  // D-086: individual primitive selectors — each returns a stable value.
  // (Previous selector returned a NEW OBJECT each call → useSyncExternalStore's
  // Object.is comparison never matched → infinite re-render loop → root crash
  // "Something went wrong / A stored version of the site may be out of date"
  // on EVERY page, private window included.)
  const real = useWalletStore((s) => s.real);
  const bonus = useWalletStore((s) => s.bonus);
  const gifted = useWalletStore((s) => s.gifted);
  const locked = useWalletStore((s) => s.locked);
  const set = useWalletStore((s) => s.setBalance);
  const balance = { real, bonus, gifted, locked };
  // keep wallet store in sync via balance:update socket event
  useEffect(() => {
    const handler = (b: {
      real: number;
      bonus: number;
      gifted: number;
      locked: number;
    }) => set(b);
    socket.on('balance:update', handler);
    return () => {
      socket.off('balance:update', handler);
    };
  }, [set]);
  return [balance, set];
}

function BigWinTicker() {
  const [wins, setWins] = useState<
    Array<{
      userId_masked: string;
      game: string;
      payoutAmount: number;
      multiplier: number;
    }>
  >([]);
  useQuery({
    queryKey: ['bigwins'],
    queryFn: () =>
      http
        .get<
          Array<{
            userId_masked: string;
            game: string;
            payoutAmount: number;
            multiplier: number;
          }>
        >('/games/aviator/live-feed')
        .then((d) => (Array.isArray(d) ? d : [])),
  });
  useEffect(() => {
    const handler = (w: {
      userId_masked: string;
      game: string;
      payoutAmount: number;
      multiplier: number;
    }) => setWins((ws) => [w, ...ws].slice(0, 10));
    socket.on('lobby:big-win', handler);
    return () => {
      socket.off('lobby:big-win', handler);
    };
  }, []);
  if (wins.length === 0) return null;
  const items = [...wins, ...wins]; // duplicate for seamless marquee
  return (
    <div className="h-9 bg-gold/5 border-b border-gold/10 flex items-center overflow-hidden">
      <span className="t-label-sm uppercase tracking-wide text-gold/70 px-3 border-r border-gold/15 shrink-0">
        🏆 {t(detectLang(), 'lobby.bigWins')}
      </span>
      <div className="flex-1 overflow-hidden">
        <div className="animate-ticker flex gap-8 whitespace-nowrap pl-4">
          {items.map((w, i) => (
            <span key={i} className="t-label-md text-white/70">
              🎉 <b className="text-white/90">{w.userId_masked}</b> won{' '}
              <b className="text-gold">₨{w.payoutAmount.toLocaleString()}</b> on{' '}
              {w.game}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
