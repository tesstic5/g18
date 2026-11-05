// apps/web/src/components/ui.tsx — Skeleton, ErrorBoundary, EmptyState, BetHistory, NotificationBell.
// Canonical: docs/19 §1–3 + docs/18 GAME HISTORY TABS + docs/21 shared feed row.
'use client';
import React, { Component, ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../lib/api';
import { socket } from '../lib/app';
import { useAuthStore } from '../stores';

// ── Skeleton (docs/19 §2 — shape-matching, shimmer, 3s → error) ────────────
export function Skeleton({
  className = '',
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`animate-shimmer rounded-md bg-layer-floating ${className}`}
      style={style}
    />
  );
}
export function SkeletonGrid({
  count = 12,
  cols = 2,
}: {
  count?: number;
  cols?: number;
}) {
  return (
    <div
      className={`grid gap-3`}
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="aspect-[16/10] rounded-xl overflow-hidden">
          <Skeleton className="w-full h-full" />
          <Skeleton className="w-3/5 h-3 mt-2" />
        </div>
      ))}
    </div>
  );
}

// ── ErrorBoundary (docs/19 §1) ─────────────────────────────────────────────
interface EBProps {
  children: ReactNode;
  fallback?: ReactNode;
}
export class ErrorBoundary extends Component<EBProps, { hasError: boolean }> {
  override state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    void http
      .post(
        '/errors',
        {
          name: error.name,
          message: error.message,
          componentStack: info.componentStack ?? undefined,
          path: window.location.pathname,
          buildId: process.env.NEXT_PUBLIC_BUILD_ID || 'unknown',
          userAgent: navigator.userAgent,
        },
        { skipAuth: true, timeoutMs: 3000 }
      )
      .catch(() => {});
  }
  override render() {
    if (!this.state.hasError) return this.props.children;
    return (
      this.props.fallback ?? (
        <div className="flex flex-col items-center justify-center min-h-[40vh] p-8 text-center gap-4">
          <span className="text-4xl text-gold">⚠️</span>
          <h2 className="t-label-xl text-primary">Something went wrong</h2>
          <p className="t-body text-secondary">
            We're looking into it. Your balance is safe.
          </p>
          <button
            className="btn-primary"
            onClick={() => this.setState({ hasError: false })}
          >
            Try Again
          </button>
          <button
            className="t-label-md text-secondary"
            onClick={() => (window.location.href = '/')}
          >
            Go Home
          </button>
        </div>
      )
    );
  }
}

// ── EmptyState (docs/19 §3) ─────────────────────────────────────────────────
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: string;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-6 text-center gap-2">
      <span className="text-5xl text-white/30 mb-2">{icon}</span>
      <p className="t-label-xl text-secondary">{title}</p>
      <p className="t-body text-muted max-w-xs">{body}</p>
      {action}
    </div>
  );
}

// ── BetHistory (v4 + docs/18 + docs/21 feed row) ───────────────────────────
interface BetRow {
  id: string;
  username: string;
  betAmount: number;
  multiplier: number;
  profit: number;
  result: 'WIN' | 'LOSE' | 'CASHOUT';
  time: string;
}
interface HistoryPage {
  data: RawRow[];
  pagination?: { total?: number };
}

/**
 * The three tabs are fed by THREE different server shapes, and none of them
 * matched `BetRow`. Every row therefore rendered as "− −₨NaN":
 *
 *   my   → GET /games/:slug/history  { id, betAmount, result, payoutMultiplier,
 *                                      payoutAmount, createdAt }   (no username/
 *                                      profit/multiplier/time)
 *   all  → socket 'game:live-bet'    { userId_masked, betAmount, result:'win'|
 *                                      'lose', payoutMultiplier, payoutAmount }
 *                                      (no id → React key collisions too)
 *   top  → GET /games/:slug/live-feed{ user, game, betAmount, payoutAmount,
 *                                      multiplier, at }
 *
 * `normalizeRow` maps any of them onto BetRow. profit = payout − stake, so a
 * loss shows −₨stake and a win shows +₨(payout − stake).
 */
interface RawRow {
  id?: string;
  username?: string;
  user?: string;
  userId_masked?: string;
  betAmount?: number | string;
  multiplier?: number | string;
  payoutMultiplier?: number | string;
  profit?: number | string;
  payoutAmount?: number | string;
  result?: string;
  time?: string;
  createdAt?: string;
  at?: number;
  game?: string; // live-feed rows carry the slug; unused here but must not be a type error
}

function timeLabel(v: string | number | undefined): string {
  if (v === undefined) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function normalizeRow(r: RawRow, i: number): BetRow {
  const bet = Number(r.betAmount ?? 0) || 0;
  const payout = Number(r.payoutAmount ?? 0) || 0;
  const mult = Number(r.multiplier ?? r.payoutMultiplier ?? 0) || 0;
  const raw = String(r.result ?? '').toUpperCase();
  // live-feed rows carry no `result` at all — they are wins by construction
  const result: BetRow['result'] =
    raw === 'WIN' || raw === 'CASHOUT' || raw === 'LOSE' || raw === 'BUST'
      ? raw === 'BUST'
        ? 'LOSE'
        : (raw as BetRow['result'])
      : payout > 0
        ? 'WIN'
        : 'LOSE';
  return {
    id: String(r.id ?? `${r.at ?? r.createdAt ?? ''}-${i}`),
    username: String(r.username ?? r.user ?? r.userId_masked ?? 'You'),
    betAmount: bet,
    multiplier: mult,
    profit: Number(r.profit ?? payout - bet) || 0,
    result,
    time: r.time ?? timeLabel(r.createdAt ?? r.at),
  };
}
export function BetHistory({ slug }: { slug: string; showLiveFeed?: boolean }) {
  const [tab, setTab] = useState<'my' | 'all' | 'top'>('my');
  const user = useAuthStore((s) => s.user);
  // D-084: the API returns { data, pagination } — read `.data`. Previously the
  // whole object was treated as an array → rows.map() crashed for LOGGED-IN
  // users on every game page ("Something went wrong"); guests were spared
  // because the query is disabled when signed out.
  const { data: historyPage } = useQuery({
    queryKey: ['history', slug],
    queryFn: () => http.get<HistoryPage>(`/games/${slug}/history?page=1&pageSize=20`),
    enabled: !!user,
  });
  // Top Wins tab: recent wins from all players (public endpoint)
  const { data: topWins } = useQuery({
    queryKey: ['history-top', slug],
    queryFn: () =>
      http
        .get<RawRow[]>(`/games/${slug}/live-feed`)
        .then((d) => (Array.isArray(d) ? d : []))
        .catch(() => []),
    enabled: tab === 'top',
  });
  const [live, setLive] = useState<RawRow[]>([]);

  React.useEffect(() => {
    if (tab !== 'all') return;
    const handler = (row: unknown) =>
      setLive((rows) => [row as RawRow, ...rows].slice(0, 20)); // docs/21: never > 20
    socket.on('game:live-bet', handler);
    return () => {
      socket.off('game:live-bet', handler);
    };
  }, [tab, slug]);

  const raw: RawRow[] =
    tab === 'my' ? (historyPage?.data ?? []) : tab === 'all' ? live : (topWins ?? []);
  // Normalize the three different server shapes into one row type (see above).
  const rows: BetRow[] = raw.map(normalizeRow);

  return (
    <div className="game-history h-[180px] flex flex-col border-t border-white/5">
      <div className="flex h-10 px-4 gap-1 border-b border-white/5">
        {(
          [
            ['my', 'My Bets'],
            ['all', 'All Bets'],
            ['top', 'Top Wins'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`h-10 px-3 t-label-md transition-colors border-b-2 ${tab === key ? 'text-white border-gold' : 'text-white/55 border-transparent'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 && !user ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 px-4">
            <span className="text-2xl">🔐</span>
            <p className="t-label-md text-secondary">Log in to see your bets</p>
            <a
              href={`/login?redirect=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname : '/games')}`}
              className="btn-outline-gold h-9 px-4 rounded-lg"
            >
              Log in
            </a>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="🎲"
            title="No bets yet"
            body="Place your first bet to see history here"
          />
        ) : (
          rows.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-3 px-4 py-2.5 border-l-2 animate-[feed-in_200ms_ease-out]"
              style={{
                borderColor:
                  r.result === 'LOSE'
                    ? '#ff3b5c'
                    : r.result === 'CASHOUT'
                      ? '#4d9fff'
                      : '#00d97e',
              }}
            >
              <span
                className={`w-2 h-2 rounded-full ${r.result === 'LOSE' ? 'bg-white/15' : 'bg-green'}`}
              />
              <span className="t-label-md text-white/70 w-[72px] truncate">
                {r.username}
              </span>
              <span className="t-num-md text-white/40 w-[60px] truncate">
                {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
                {r.betAmount.toFixed(2)}
              </span>
              <span className="t-num-md text-white/60">
                {r.multiplier > 0 ? `×${r.multiplier}` : '−'}
              </span>
              <span
                className={`t-num-md ml-auto ${r.profit >= 0 ? 'text-green' : 'text-red/70'}`}
              >
                {r.profit >= 0 ? '+' : '−'}
                {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
                {Math.abs(r.profit).toFixed(2)}
              </span>
              <span className="t-label-sm text-white/25 w-12 text-right">{r.time}</span>
            </div>
          ))
        )}
      </div>
      <style>{`@keyframes feed-in{0%{height:0;opacity:0;transform:translateY(-8px)}100%{height:48px;opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}

// ── NotificationBell (docs/18) ─────────────────────────────────────────────
// D-091: the dropdown renders through a PORTAL to <body> with z-[200] so no
// page layout can ever cover it (the game pages' own top bar is a z-100 flex
// item that previously painted OVER the dropdown, which looked like the bell
// "did nothing" on game pages). Fixed positioning keeps it under the bell.
export function NotificationBell() {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  // D-063: only fetch when logged in — when signed out this would 401 and the
  // api client's 401 handler would bounce the user to /login on every page.
  const { data: items } = useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      http.get<
        Array<{
          id: string;
          title: string;
          body: string;
          type: string;
          isRead: boolean;
        }>
      >('/notifications'),
    enabled: !!user,
  });

  // D-083 + D-091: refetch the list when a new notification arrives over the
  // socket (so opening the bell shows the fresh item, not the stale list).
  // The socket itself is now kept alive across SPA logins (see providers.tsx).
  React.useEffect(() => {
    // M-10: keep a REFERENCE to our handler and remove exactly it — a bare
    // socket.off('notification:new') unregisters EVERY listener for that
    // event (wallet/deposit components lost their updates when the bell
    // unmounted).
    const onNew = () => {
      setUnread((u) => u + 1);
      qc.invalidateQueries({ queryKey: ['notifications'] });
    };
    socket.on('notification:new', onNew);
    return () => {
      socket.off('notification:new', onNew);
    };
  }, [qc]);
  React.useEffect(() => {
    setUnread(items?.filter((n) => !n.isRead).length ?? 0);
  }, [items]);

  // close the dropdown when navigating (portal survives page transitions)
  const pathname = usePathname();
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const markAllRead = async () => {
    try {
      await http.post('/notifications/read-all', undefined);
      setUnread(0);
      qc.invalidateQueries({ queryKey: ['notifications'] });
    } catch {
      /* non-critical */
    }
  };

  return (
    <div className="relative">
      <button
        aria-label="Notifications"
        className="w-10 h-10 flex items-center justify-center relative"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-white/60 text-xl">🔔</span>
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-red text-white text-[10px] font-bold flex items-center justify-center">
            {unread}
          </span>
        )}
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed right-2 sm:right-4 top-16 z-[200] w-[min(92vw,320px)] max-h-[70dvh] overflow-y-auto rounded-xl bg-layer-elevated border border-white/10 shadow-[0_16px_48px_rgba(0,0,0,0.6)]">
            {/* header */}
            <div className="sticky top-0 bg-layer-elevated z-10 px-4 py-3 border-b border-white/8 flex items-center justify-between">
              <p className="t-label-lg text-primary">Notifications</p>
              <button
                onClick={markAllRead}
                className="t-label-sm text-gold underline underline-offset-2"
              >
                Mark all read
              </button>
            </div>
            {!items || items.length === 0 ? (
              <div className="p-6 text-center">
                <p className="text-3xl mb-2">🔔</p>
                <p className="t-label-md text-primary">You're all caught up</p>
                <p className="t-body text-secondary text-sm mt-1">
                  We'll notify you about wins, bonuses, and deposits
                </p>
              </div>
            ) : (
              items.map((n) => (
                <div
                  key={n.id}
                  className={`p-3 border-b border-white/5 ${n.isRead ? '' : 'bg-gold/5 border-l-[3px] border-l-gold'}`}
                >
                  <p className="t-label-lg text-primary">{n.title}</p>
                  <p className="t-body text-secondary text-sm">{n.body}</p>
                </div>
              ))
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
