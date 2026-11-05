// apps/web/src/app/(player)/leaderboard/page.tsx
'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { http } from '../../../lib/api';
import { useAuthStore } from '../../../stores';
import { Skeleton } from '../../../components/ui';

export default function LeaderboardPage() {
  const user = useAuthStore((s) => s.user);
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'all_time'>('daily');
  const { data, isLoading } = useQuery({
    queryKey: ['leaderboard', period],
    queryFn: () =>
      http.get<Array<{ rank: number; masked: string; totalWagered: number }>>(
        `/leaderboard/${period}?limit=20`
      ),
    enabled: !!user, // D-063: endpoint requires auth — don't fire for guests
  });

  // D-072/074: guests get a login CTA instead of an empty table
  if (!user) {
    return (
      <div className="px-4 py-6 max-w-md mx-auto">
        <h1 className="t-title text-primary mb-4">Leaderboard</h1>
        <div className="rounded-2xl bg-layer-surface border border-white/8 p-6 text-center">
          <p className="text-4xl mb-3">🏆</p>
          <h2 className="t-label-xl text-primary mb-2">Top players this week</h2>
          <p className="t-body text-secondary mb-6">
            Log in to see who's winning the most.
          </p>
          <div className="flex gap-2">
            <a href="/login" className="btn-primary flex-1">
              Log in
            </a>
            <a href="/signup" className="btn-outline-gold flex-1">
              Sign up
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-6 max-w-md mx-auto">
      <h1 className="t-title text-primary mb-4">Leaderboard</h1>
      <div className="flex gap-2 mb-4">
        {(['daily', 'weekly', 'all_time'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`h-9 px-4 rounded-full t-label-md ${period === p ? 'bg-gold/15 border border-gold/35 text-gold' : 'bg-white/5 text-white/60'}`}
          >
            {p.replace('_', ' ')}
          </button>
        ))}
      </div>
      {isLoading ? (
        <Skeleton className="h-64" />
      ) : !data?.length ? (
        <div className="rounded-xl border border-white/8 bg-layer-surface p-10 text-center">
          <p className="text-3xl mb-2">🏆</p>
          <p className="t-label-md text-secondary">
            No bets yet this {period.replace('_', ' ')} — be the first!
          </p>
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden border border-white/8 divide-y divide-white/5">
          {data.map((e) => (
            <div
              key={e.rank}
              className="flex items-center gap-3 px-4 py-3 bg-layer-surface"
            >
              <span
                className={`w-8 h-8 rounded-full flex items-center justify-center t-label-lg ${e.rank <= 3 ? 'bg-gold/20 text-gold' : 'bg-layer-elevated text-white/50'}`}
              >
                {e.rank}
              </span>
              <span className="t-label-lg text-primary flex-1">{e.masked}</span>
              <span className="t-num-md text-gold">
                ₨{e.totalWagered.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
