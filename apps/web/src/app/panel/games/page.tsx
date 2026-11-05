// apps/web/src/app/panel/games/page.tsx — game list (active toggle, odds summary)
'use client';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from '../../../lib/api';
import {
  AdminTable,
  PageHeader,
  Badge,
  type Column,
} from '../../../components/admin/ui';
import { notify } from '../../../lib/toast';

interface GameRow {
  slug: string;
  displayName: string;
  isActive: boolean;
  tags: string[];
  baseRtp: number;
  winRate: number;
  forceOverride: string;
  forceRoundsLeft: number;
}

export default function GamesPage() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['panel-games'],
    queryFn: () => http.get<GameRow[]>('/panel/games'),
  });
  const toggle = useMutation({
    mutationFn: (g: GameRow) =>
      http.patch(`/panel/games/${g.slug}`, { isActive: !g.isActive }),
    onSuccess: () => {
      notify.success('Toggled — audit logged');
      qc.invalidateQueries({ queryKey: ['panel-games'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });
  // v1.4.0: hot toggle — adds/removes the 'hot' tag; the lobby instantly shows
  // the game in the pinned 🔥 Hot row on top + rotates it in the banner.
  const toggleHot = useMutation({
    mutationFn: (g: GameRow) => {
      const tags = (g.tags ?? []).filter((t) => t !== 'hot');
      if (!g.tags?.includes('hot')) tags.push('hot');
      return http.patch(`/panel/games/${g.slug}`, { tags });
    },
    onSuccess: () => {
      notify.success('Hot toggled — audit logged');
      qc.invalidateQueries({ queryKey: ['panel-games'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });
  const cols: Column<GameRow>[] = [
    {
      key: 'name',
      header: 'Game',
      render: (r) => (
        <Link
          href={`/panel/games/${r.slug}`}
          className="t-label-lg text-primary hover:text-gold"
        >
          {r.displayName}
        </Link>
      ),
    },
    {
      key: 'rtp',
      header: 'RTP',
      render: (r) => (
        <span className="t-num-md text-secondary">{Number(r.baseRtp).toFixed(2)}%</span>
      ),
    },
    {
      key: 'wr',
      header: 'Win rate',
      render: (r) => (
        <span className="t-num-md text-secondary">{Number(r.winRate).toFixed(2)}%</span>
      ),
    },
    {
      key: 'force',
      header: 'Override',
      render: (r) =>
        r.forceOverride !== 'NONE' ? (
          <Badge color="orange">
            {r.forceOverride} ×{r.forceRoundsLeft}
          </Badge>
        ) : (
          <span className="t-label-sm text-muted">none</span>
        ),
    },
    {
      key: 'hot',
      header: 'Hot',
      render: (r) => (
        <button
          onClick={() => toggleHot.mutate(r)}
          className={`h-8 px-3 rounded-lg t-label-md ${r.tags?.includes('hot') ? 'bg-orange/15 text-orange' : 'bg-white/5 text-white/40'}`}
        >
          {r.tags?.includes('hot') ? '🔥 HOT' : 'not hot'}
        </button>
      ),
    },
    {
      key: 'active',
      header: 'Visible',
      render: (r) => (
        <button
          onClick={() => toggle.mutate(r)}
          className={`h-8 px-3 rounded-lg t-label-md ${r.isActive ? 'bg-green/15 text-green' : 'bg-white/5 text-white/40'}`}
        >
          {r.isActive ? 'Visible' : 'Hidden'}
        </button>
      ),
    },
  ];
  if (error) {
    return (
      <div>
        <PageHeader title="Games" />
        <div className="rounded-xl border border-red/30 bg-red/10 p-5">
          <p className="text-red t-label-lg">Could not load games</p>
          <p className="text-white/60 t-label-sm mt-1">{(error as Error).message}</p>
          <button className="btn-ghost h-10 px-4 mt-4" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <PageHeader title="Games" />
      <AdminTable
        columns={cols}
        rows={data ?? []}
        loading={isLoading}
        empty="No games"
        rowKey={(r) => r.slug}
      />
    </div>
  );
}
