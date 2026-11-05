// apps/web/src/app/panel/page.tsx — professional dashboard (D-068)
// KPI cards + 14-day revenue chart + game performance + top players + live activity feed.
'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { io } from 'socket.io-client';
import { http } from '../../lib/api';
import { wsBaseUrl } from '../../lib/env';
import {
  StatCard,
  Card,
  CardHead,
  Badge,
  Icon,
  timeAgo,
  fmt,
  Spinner,
} from '../../components/admin/ui';
import { BarChart, HBarList } from '../../components/admin/charts';

interface Stats {
  totals: { users: number; volume: number; ggr: number };
  week: { volume: number; ggr: number };
  today: {
    bets: number;
    volume: number;
    payout: number;
    ggr: number;
    deposits: { count: number; amount: number };
    withdrawals: { count: number; amount: number };
    signups: number;
  };
  activeUsers: number;
  pendingDeposits: { count: number; amount: number };
  pendingWithdrawals: { count: number; amount: number };
}

type FeedItem = {
  kind: 'bet' | 'signup' | 'deposit' | 'withdrawal';
  id: string;
  at: number;
  user: string;
  game?: string;
  amount?: number;
  result?: string;
  payout?: number;
  status?: string;
  method?: string;
};

const GAME_LABEL: Record<string, string> = {
  'coin-flip': 'Coin Flip',
  dice: 'Dice',
  wheel: 'Wheel',
  mines: 'Mines',
  plinko: 'Plinko',
  'crash-x': 'Crash X',
  aviator: 'Aviator',
  wingo: 'Wingo',
  blackjack: 'Blackjack',
  roulette: 'Roulette',
  baccarat: 'Baccarat',
  poker: 'Poker',
  slots: 'Slots',
  keno: 'Keno',
  lottery: 'Lottery',
  limbo: 'Limbo',
  'rock-paper-scissors': 'RPS',
  'dragon-tiger': 'Dragon Tiger',
  'sic-bo': 'Sic Bo',
  'space-odyssey': 'Space Odyssey',
};

export default function Dashboard() {
  const { data: stats } = useQuery({
    queryKey: ['panel-dash'],
    queryFn: () => http.get<Stats>('/panel/dashboard/stats'),
    refetchInterval: 30_000,
  });
  const { data: trend } = useQuery({
    queryKey: ['panel-trend'],
    queryFn: () =>
      http.get<Array<{ date: string; volume: number; payout: number; ggr: number }>>(
        '/panel/dashboard/revenue-trend?days=14'
      ),
    refetchInterval: 60_000,
  });
  const { data: games } = useQuery({
    queryKey: ['panel-games-perf'],
    queryFn: () =>
      http.get<
        Array<{
          slug: string;
          name: string;
          rounds: number;
          volume: number;
          payout: number;
          ggr: number;
          rtp: number | null;
        }>
      >('/panel/dashboard/game-performance?days=7'),
    refetchInterval: 60_000,
  });
  const { data: top } = useQuery({
    queryKey: ['panel-top'],
    queryFn: () =>
      http.get<
        Array<{
          id: string;
          phone: string;
          displayName: string | null;
          rounds: number;
          wagered: number;
          won: number;
          net: number;
        }>
      >('/panel/dashboard/top-players?days=7&limit=8'),
    refetchInterval: 60_000,
  });

  // Live feed: socket (admin ws-token) + REST fallback poll
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const feedRef = useRef<FeedItem[]>([]);
  const [live, setLive] = useState(false);
  const push = (items: FeedItem[]) => {
    feedRef.current = [...items, ...feedRef.current].slice(0, 40);
    setFeed(feedRef.current);
  };

  useEffect(() => {
    let sock: ReturnType<typeof io> | null = null;
    let cancelled = false;
    http
      .get<{ token: string }>('/panel/auth/ws-token')
      .then(({ token }) => {
        if (cancelled) return;
        sock = io(wsBaseUrl(), {
          auth: { token },
          transports: ['websocket', 'polling'],
          reconnectionDelay: 3000,
        });
        const on = (kind: FeedItem['kind']) => (p: FeedItem & { userId?: string }) => {
          if (cancelled) return;
          setLive(true);
          push([
            {
              kind,
              id: p.id ?? Math.random().toString(36).slice(2),
              at: p.at ?? Date.now(),
              user: p.user ?? `#${(p.userId ?? '').slice(0, 8)}`,
              game: p.game,
              amount: p.amount,
              result: p.result,
              payout: p.payout,
              status: p.status,
            },
          ]);
        };
        sock.on('admin:live-bet', on('bet'));
        sock.on('admin:new-deposit', on('deposit'));
        sock.on('admin:new-signup', on('signup'));
        sock.on('admin:withdrawal-request', on('withdrawal'));
      })
      .catch(() => {});
    const poll = () => {
      http
        .get<FeedItem[]>('/panel/dashboard/recent-activity?limit=25')
        .then((rows) => {
          if (!cancelled) push(rows);
        })
        .catch(() => {});
    };
    poll();
    const t = setInterval(poll, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
      sock?.disconnect();
    };
  }, []);

  const trendData = useMemo(
    () =>
      (trend ?? []).map((d) => ({
        label: d.date.slice(5),
        value: d.volume,
        value2: d.payout,
      })),
    [trend]
  );
  const gameRows = useMemo(
    () =>
      (games ?? []).slice(0, 8).map((g) => ({
        label: g.name,
        value: g.volume,
        badge:
          g.rtp !== null ? (
            <Badge color={g.rtp > 97 ? 'green' : g.rtp > 90 ? 'gold' : 'orange'}>
              {g.rtp.toFixed(1)}% RTP
            </Badge>
          ) : undefined,
        sub: `${g.rounds.toLocaleString()} rounds · ${fmt(g.ggr)} profit`,
      })),
    [games]
  );

  const s = stats;
  const cards = [
    {
      label: 'Active users (15m)',
      value: String(s?.activeUsers ?? 0),
      icon: 'users',
      accent: 'blue' as const,
      hint: 'online now',
    },
    {
      label: 'Signups today',
      value: String(s?.today.signups ?? 0),
      icon: 'plus',
      accent: 'green' as const,
      trend: s && s.totals.users ? `of ${s.totals.users} total` : undefined,
    },
    {
      label: 'Bets today',
      value: String(s?.today.bets ?? 0),
      icon: 'games',
      accent: 'violet' as const,
    },
    {
      label: 'Volume today',
      value: fmt(s?.today.volume ?? 0),
      icon: 'coins',
      accent: 'gold' as const,
      trend: s
        ? `${s.today.volume >= 0 ? '+' : ''}${Math.round((s.today.volume / Math.max(1, s.week.volume)) * 100)}% of week`
        : undefined,
    },
    {
      label: 'Profit today (GGR)',
      value: fmt(s?.today.ggr ?? 0),
      icon: 'chart',
      accent: 'green' as const,
      trend:
        s && s.today.ggr > 0
          ? `+${Math.round((s.today.ggr / Math.max(1, s.week.ggr)) * 100)}% of week`
          : undefined,
      up: (s?.today.ggr ?? 0) >= 0,
    },
    {
      label: 'Deposits today',
      value: `${s?.today.deposits.count ?? 0} · ${fmt(s?.today.deposits.amount ?? 0)}`,
      icon: 'deposits',
      accent: 'gold' as const,
    },
    {
      label: 'Withdrawals today',
      value: `${s?.today.withdrawals.count ?? 0} · ${fmt(s?.today.withdrawals.amount ?? 0)}`,
      icon: 'withdrawals',
      accent: 'red' as const,
    },
    {
      label: 'Pending queues',
      value: `${s?.pendingDeposits.count ?? 0} dep · ${s?.pendingWithdrawals.count ?? 0} wd`,
      icon: 'bell',
      accent: 'orange' as const,
      hint: s
        ? `${fmt(s.pendingDeposits.amount)} + ${fmt(s.pendingWithdrawals.amount)} awaiting review`
        : undefined,
    },
  ];

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map((c) => (
          <StatCard key={c.label} {...c} />
        ))}
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        <Link
          href="/panel/deposits"
          className="h-9 px-4 rounded-lg bg-gold/15 border border-gold/30 t-label-md text-gold hover:bg-gold/25 inline-flex items-center gap-2"
        >
          <Icon name="deposits" size={15} /> Review deposits{' '}
          {s && s.pendingDeposits.count > 0 && (
            <Badge color="gold">{s.pendingDeposits.count}</Badge>
          )}
        </Link>
        <Link
          href="/panel/withdrawals"
          className="h-9 px-4 rounded-lg bg-white/5 border border-white/10 t-label-md text-white/70 hover:bg-white/10 inline-flex items-center gap-2"
        >
          <Icon name="withdrawals" size={15} /> Review withdrawals{' '}
          {s && s.pendingWithdrawals.count > 0 && (
            <Badge color="gold">{s.pendingWithdrawals.count}</Badge>
          )}
        </Link>
        <Link
          href="/panel/users"
          className="h-9 px-4 rounded-lg bg-white/5 border border-white/10 t-label-md text-white/70 hover:bg-white/10 inline-flex items-center gap-2"
        >
          <Icon name="users" size={15} /> Manage users
        </Link>
        <Link
          href="/panel/reports"
          className="h-9 px-4 rounded-lg bg-white/5 border border-white/10 t-label-md text-white/70 hover:bg-white/10 inline-flex items-center gap-2"
        >
          <Icon name="reports" size={15} /> Reports & CSV export
        </Link>
      </div>

      {/* Charts row */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHead
            title="Revenue — last 14 days"
            icon="chart"
            right={
              <div className="flex items-center gap-3 t-label-sm text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-gold inline-block" /> Volume
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-white/30 inline-block" />{' '}
                  Payouts
                </span>
              </div>
            }
          />
          {trendData.length ? (
            <BarChart data={trendData} height={190} />
          ) : (
            <Spinner label="Loading trend…" />
          )}
        </Card>
        <Card>
          <CardHead
            title="Game performance — 7 days"
            icon="games"
            right={
              <Link
                href="/panel/games"
                className="t-label-sm text-gold hover:underline"
              >
                manage →
              </Link>
            }
          />
          {gameRows.length ? (
            <HBarList rows={gameRows} />
          ) : (
            <Spinner label="Loading games…" />
          )}
        </Card>
      </div>

      {/* Top players + live feed */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHead
            title="Top players — 7 days"
            icon="trophy"
            right={
              <Link
                href="/panel/users"
                className="t-label-sm text-gold hover:underline"
              >
                all users →
              </Link>
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-white/5">
                  {['#', 'Player', 'Rounds', 'Wagered', 'Won', 'Net'].map((h) => (
                    <th
                      key={h}
                      className="text-left px-3 py-2.5 t-label-sm uppercase tracking-wide text-muted font-medium whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {(top ?? []).map((p, i) => (
                  <tr key={p.id} className="hover:bg-white/2">
                    <td className="px-3 py-2.5 t-num-sm text-muted">{i + 1}</td>
                    <td className="px-3 py-2.5 t-label-md text-white/85">
                      {p.displayName || p.phone}
                    </td>
                    <td className="px-3 py-2.5 t-num-sm text-white/60">{p.rounds}</td>
                    <td className="px-3 py-2.5 t-num-sm text-white/60">
                      {fmt(p.wagered)}
                    </td>
                    <td className="px-3 py-2.5 t-num-sm text-green">{fmt(p.won)}</td>
                    <td
                      className={`px-3 py-2.5 t-num-sm ${p.net > 0 ? 'text-green' : p.net < 0 ? 'text-red' : 'text-white/60'}`}
                    >
                      {p.net > 0 ? '+' : ''}
                      {fmt(p.net)}
                    </td>
                  </tr>
                ))}
                {top && top.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-8 text-center t-label-sm text-muted"
                    >
                      No bets in the last 7 days yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card pad={false}>
          <CardHead
            title="Live activity"
            icon="live"
            right={
              <span className="flex items-center gap-1.5 t-label-sm">
                <span
                  className={`h-2 w-2 rounded-full ${live ? 'bg-green animate-pulse' : 'bg-white/20'}`}
                />
                <span className={live ? 'text-green' : 'text-muted'}>
                  {live ? 'LIVE' : 'polling'}
                </span>
              </span>
            }
          />
          <div className="h-72 overflow-y-auto divide-y divide-white/4 px-4">
            {feed.length === 0 && (
              <p className="py-8 text-center t-label-sm text-muted">
                No activity yet — place a test bet to see it here.
              </p>
            )}
            {feed.map((f, i) => (
              <div
                key={`${f.id}-${i}`}
                className="py-2 flex items-center gap-2.5 text-sm"
              >
                <span
                  className={`shrink-0 h-7 w-7 rounded-lg flex items-center justify-center ${f.kind === 'bet' ? 'bg-violet-400/12 text-violet-300' : f.kind === 'deposit' ? 'bg-green/12 text-green' : f.kind === 'signup' ? 'bg-sky-400/12 text-sky-300' : 'bg-orange-400/12 text-orange-300'}`}
                >
                  <Icon
                    name={
                      f.kind === 'bet'
                        ? 'games'
                        : f.kind === 'deposit'
                          ? 'deposits'
                          : f.kind === 'signup'
                            ? 'plus'
                            : 'withdrawals'
                    }
                    size={13}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="t-label-md text-white/85 truncate">
                    {f.kind === 'bet' && (
                      <>
                        {f.user} <span className="text-gold">bet</span>{' '}
                        {fmt(f.amount ?? 0)} on{' '}
                        <span className="text-white/60">
                          {GAME_LABEL[f.game ?? ''] ?? f.game}
                        </span>
                      </>
                    )}
                    {f.kind === 'deposit' && (
                      <>
                        {f.user} <span className="text-green">deposited</span>{' '}
                        {fmt(f.amount ?? 0)}
                      </>
                    )}
                    {f.kind === 'signup' && (
                      <>
                        {f.user} <span className="text-sky-300">joined</span>
                      </>
                    )}
                    {f.kind === 'withdrawal' && (
                      <>
                        {f.user} <span className="text-orange-300">requested</span>{' '}
                        {fmt(f.amount ?? 0)} withdrawal
                      </>
                    )}
                  </p>
                  <p className="t-label-sm text-muted">
                    {timeAgo(f.at)}
                    {f.kind === 'bet' && f.payout ? ` · payout ${fmt(f.payout)}` : ''}
                  </p>
                </div>
                {f.kind === 'bet' && f.result && (
                  <Badge
                    color={
                      f.result === 'WIN' || f.result === 'CASHOUT' ? 'green' : 'white'
                    }
                  >
                    {f.result === 'CASHOUT' ? 'CASHED' : f.result}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
