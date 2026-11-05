// apps/web/src/components/HomeCheckin.tsx — DAILY BONUS hero (D-067, D-079).
// Compact & professional: on large screens it's a slim horizontal band
// (title + streak · 7-day dots · reward + claim). Guests see a teaser.
'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from '../lib/api';
import { applyServerBalance, refreshBalance, useAuthStore } from '../stores';
import { invalidate } from '../lib/app';
import { notify } from '../lib/toast';

interface StreakData {
  streak: number;
  claimedToday: boolean;
  nextBonus: number;
  history: string[];
  /** live fields so the button can explain itself instead of failing on tap */
  nextDay?: number;
  streakBroken?: boolean;
  eligible?: boolean;
  reason?: string | null;
  minBalance?: number;
  balance?: number;
}

export function HomeCheckin() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['checkin-home'],
    queryFn: () => http.get<StreakData>('/bonuses/streak-status'),
    enabled: !!user,
  });
  const claim = useMutation({
    mutationFn: () =>
      http.post<{ bonus: string; newBalance?: unknown }>('/bonuses/daily-checkin'),
    onSuccess: (r) => {
      notify.success(
        `+${process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}${Number(r.bonus).toLocaleString()} added to your bonus wallet`
      );
      if (r.newBalance) applyServerBalance(r.newBalance);
      else void refreshBalance().catch(() => {});
      qc.invalidateQueries({ queryKey: ['checkin-home'] });
      invalidate.checkin();
      invalidate.transactions();
      invalidate.balance();
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const claimedToday = data?.claimedToday ?? false;

  // ── GUEST TEASER ─────────────────────────────────────────────────────────
  if (!user) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-gold/20 bg-gradient-to-r from-[#241c08] via-layer-surface to-layer-void p-4 sm:p-5">
        <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full bg-gold/12 blur-3xl" />
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🎁</span>
            <div>
              <p className="t-label-lg text-gold leading-tight">Daily Bonus</p>
              <p className="t-label-sm text-secondary">Claim free coins every day</p>
            </div>
          </div>
          <div className="flex gap-2">
            <a href="/signup" className="btn-primary h-10 px-5 rounded-xl">
              Sign up
            </a>
            <a href="/login" className="btn-outline-gold h-10 px-5 rounded-xl">
              Log in
            </a>
          </div>
        </div>
      </div>
    );
  }

  const bonus = data?.nextBonus ?? 5;
  const streak = data?.streak ?? 0;
  // The server now tells us the day the NEXT claim will award. Previously the
  // UI derived it from a stale streak and could promise "day 2" while the claim
  // actually paid day 1.
  const nextDay = data?.nextDay ?? streak + 1;
  const eligible = data?.eligible ?? !claimedToday;
  const reason = data?.reason ?? null;
  const days = Array.from({ length: 7 }, (_, i) => i + 1);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-gold/20 bg-gradient-to-r from-[#241c08] via-layer-surface to-layer-void">
      <div className="absolute -top-10 -right-10 w-36 h-36 rounded-full bg-gold/10 blur-3xl" />
      <div className="relative flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6 px-5 py-4">
        {/* title + streak */}
        <div className="shrink-0 sm:w-44">
          <p className="t-label-lg text-gold leading-tight">🎁 Daily Bonus</p>
          <p className="t-label-sm text-white/60 mt-0.5">
            {data?.streakBroken
              ? 'Streak reset — starting again'
              : `🔥 ${streak}-day streak`}
          </p>
        </div>

        {/* 7-day dots */}
        <div className="flex items-center gap-1.5 sm:gap-2 flex-1 justify-start sm:justify-center">
          {days.map((d) => {
            const isClaimed = d <= streak;
            const isToday = d === nextDay && !claimedToday;
            return (
              <div
                key={d}
                title={
                  isClaimed
                    ? `Day ${d} — claimed`
                    : isToday
                      ? 'Claim today!'
                      : `Day ${d}`
                }
                className={`h-8 w-8 sm:h-9 sm:w-9 rounded-full flex items-center justify-center t-label-sm sm:t-label-md transition-all
                  ${
                    isClaimed
                      ? 'bg-gold/20 border border-gold/40 text-gold'
                      : isToday
                        ? 'bg-gold text-[#3d2800] animate-pulse-gold shadow-[0_0_12px_rgba(245,200,66,0.5)]'
                        : 'bg-layer-elevated text-white/40'
                  }`}
              >
                {isClaimed ? '✓' : d}
              </div>
            );
          })}
        </div>

        {/* reward + claim */}
        <div className="flex items-center gap-4 shrink-0">
          <div className="text-right">
            <p className="t-label-sm text-secondary leading-tight">
              {claimedToday ? 'Next reward' : "Today's reward"}
            </p>
            <p className="t-num-lg text-gold leading-tight">
              {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
              {bonus.toLocaleString()}
            </p>
          </div>
          <button
            disabled={!eligible || claim.isPending}
            onClick={() => claim.mutate()}
            title={reason ?? undefined}
            className="btn-primary h-10 px-6 rounded-xl"
          >
            {claim.isPending
              ? 'Claiming…'
              : claimedToday
                ? 'Claimed ✓'
                : eligible
                  ? `Claim day ${nextDay}`
                  : 'Locked'}
          </button>
        </div>
      </div>
      {/* Why the button is locked — never leave the player guessing. */}
      {reason && !claimedToday && (
        <p className="relative px-5 pb-3 -mt-1 t-label-sm text-gold/80">{reason}</p>
      )}
    </div>
  );
}
