// apps/web/src/components/pages-extras.tsx — ReferralPage, ProfilePage, LegalPageView,
// DailyCheckinCalendar. Canonical: v4 features + docs/18 + docs/19 §5 onboarding.
'use client';
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { http } from '../lib/api';
import { invalidate } from '../lib/app';
import { useAuthStore, refreshBalance, applyServerBalance } from '../stores';
import { Skeleton } from './ui';
import { notify } from '../lib/toast';

// ── REFERRAL (v4) ──────────────────────────────────────────────────────────
const CURRENCY = process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '\u20a8';

interface ReferralBonusInfo {
  enabled: boolean;
  referrerBonus: number;
  refereeBonus: number;
}
interface ReferralCodeInfo extends ReferralBonusInfo {
  code: string;
  url: string;
}

/** Copy to the clipboard with feedback — the old fallback was silent, so on
 *  desktop pressing "Share Invite" appeared to do nothing at all. */
async function copyText(text: string, label: string): Promise<void> {
  if (!text) return;
  try {
    if (!navigator.clipboard) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    notify.success(`${label} copied`);
  } catch {
    notify.error(
      `Could not copy \u2014 select the ${label.toLowerCase()} and copy it manually`
    );
  }
}

export function ReferralPage() {
  const user = useAuthStore((s) => s.user);
  // D-085: stats live in /referral/stats — /referral/code only returns {code,url}.
  // Previously the page read totalReferred/totalEarned from the wrong endpoint
  // and ALWAYS showed 0.
  const { data: codeData, isLoading } = useQuery({
    queryKey: ['referral'],
    queryFn: () => http.get<ReferralCodeInfo>('/referral/code'),
    enabled: !!user,
  });
  const { data: stats } = useQuery({
    queryKey: ['referral-stats'],
    queryFn: () =>
      http.get<{ totalReferred: number; totalEarned: number }>('/referral/stats'),
    enabled: !!user,
  });
  // Signed-out visitors get the published amounts from the public endpoint, so
  // the pitch below can never promise a figure the settings do not back.
  const { data: publicInfo } = useQuery({
    queryKey: ['referral-info'],
    queryFn: () => http.get<ReferralBonusInfo>('/referral/info'),
    enabled: !user,
  });

  const bonus: ReferralBonusInfo | undefined = user ? codeData : publicInfo;

  const share = async () => {
    const url = codeData?.url ?? '';
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join me!',
          text: 'Play casino games',
          url,
        });
        return;
      } catch {
        // user dismissed the share sheet — fall through to copying
      }
    }
    await copyText(url, 'Invite link');
  };

  // D-072: guests see a signup CTA instead of an empty page
  if (!user) {
    const theyGet = publicInfo?.refereeBonus ?? 0;
    const friendGets = publicInfo?.referrerBonus ?? 0;
    return (
      <div className="p-6 max-w-md mx-auto">
        <h1 className="t-title text-primary mb-1">Referral</h1>
        <p className="t-body text-secondary mb-6">
          Invite friends and earn bonus money when they join.
        </p>
        <div className="rounded-2xl bg-layer-surface border border-gold/25 p-6 text-center">
          <p className="text-4xl mb-3">🎁</p>
          <h2 className="t-label-xl text-primary mb-2">Earn by inviting friends</h2>
          {/* Was a hardcoded "₨25 ... signs up and plays": the ₨25 is the
              REFERRER's reward, the new player gets ₨10, and the bonus now
              pays on first deposit — not on "playing". */}
          <p className="t-body text-secondary mb-6">
            {publicInfo && (theyGet > 0 || friendGets > 0) ? (
              <>
                Join with a friend&apos;s link and you get{' '}
                <b>
                  {CURRENCY}
                  {theyGet}
                </b>
                , and they get{' '}
                <b>
                  {CURRENCY}
                  {friendGets}
                </b>{' '}
                when you make your first deposit.
              </>
            ) : (
              <>
                Share your code and you both get a bonus when your friend makes their
                first deposit.
              </>
            )}
          </p>
          <div className="flex gap-2">
            <a href="/signup" className="btn-primary flex-1">
              Sign up
            </a>
            <a href="/login" className="btn-outline-gold flex-1">
              Log in
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading)
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-12" />
      </div>
    );

  const referee = codeData?.refereeBonus ?? 0;
  const referrer = codeData?.referrerBonus ?? 0;
  const enabled = codeData?.enabled !== false;

  return (
    <div className="p-6 max-w-md mx-auto">
      <h1 className="t-title text-primary mb-1">Referral</h1>
      <p className="t-body text-secondary mb-6">
        {enabled
          ? `They get ${CURRENCY}${referee}, you get ${CURRENCY}${referrer} when they make their first deposit.`
          : 'Referral bonuses are currently switched off.'}
      </p>
      <div className="rounded-xl bg-layer-surface border border-gold/25 p-6 text-center mb-4">
        <p className="t-label-md text-secondary mb-2">Your code</p>
        <p className="t-mono text-gold text-2xl tracking-widest mb-4">
          {codeData?.code}
        </p>
        <button onClick={share} className="btn-outline-gold w-full h-12 rounded-xl">
          Share Invite
        </button>
        {/* The link used to be invisible — you could share it but never see or
            copy it yourself. */}
        <div className="mt-3 flex gap-2">
          <input
            readOnly
            value={codeData?.url ?? ''}
            aria-label="Your invite link"
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 h-10 px-3 rounded-lg bg-layer-elevated border border-white/10 text-xs text-secondary outline-none focus:border-gold/40"
          />
          <button
            onClick={() => copyText(codeData?.url ?? '', 'Invite link')}
            className="btn-outline-gold h-10 px-4 rounded-lg text-xs shrink-0"
          >
            Copy link
          </button>
        </div>
        <button
          onClick={() => copyText(codeData?.code ?? '', 'Code')}
          className="mt-2 w-full h-10 rounded-lg border border-white/10 text-xs text-secondary hover:border-gold/40 transition-colors"
        >
          Copy code only
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Friends joined" value={String(stats?.totalReferred ?? 0)} />
        <Stat label="Total earned" value={`${CURRENCY}${stats?.totalEarned ?? 0}`} />
      </div>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-layer-surface border border-white/8 p-4 text-center">
      <p className="t-num-xl text-gold">{value}</p>
      <p className="t-label-sm text-secondary mt-1">{label}</p>
    </div>
  );
}

// ── PROFILE (v4 + docs/18) ───────────────────────────────────────────────────
export function ProfilePage() {
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () =>
      http.get<{
        displayName?: string;
        phone: string;
        theme: string;
        language: string;
        sessionReminderMin?: number | null;
        dailyLossLimit?: number | string | null;
        dailyDepositLimit?: number | string | null;
        selfExcludedUntil?: string | null;
      }>('/auth/me'),
  });
  const [lossLimit, setLossLimit] = useState('');
  const [depositLimit, setDepositLimit] = useState('');
  const [reminder, setReminder] = useState('60');
  const responsible = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      http.patch('/user/responsible-play', payload),
    onSuccess: () => {
      notify.success('Responsible-play settings updated');
      void http
        .get<NonNullable<ReturnType<typeof useAuthStore.getState>['user']>>('/auth/me')
        .then((user) => {
          useAuthStore.getState().setSession(user, useAuthStore.getState().accessToken);
        })
        .catch(() => {});
    },
    onError: (error) => notify.error((error as Error).message),
  });
  const saveLimits = () =>
    responsible.mutate({
      dailyLossLimit: lossLimit === '' ? null : Number(lossLimit),
      dailyDepositLimit: depositLimit === '' ? null : Number(depositLimit),
      sessionReminderMin: reminder === '' ? null : Number(reminder),
    });
  const exclude = (hours: number) => {
    if (
      !window.confirm(
        'Self-exclusion takes effect immediately and cannot be cancelled before it expires. Continue?'
      )
    )
      return;
    responsible.mutate({ selfExclusionHours: hours });
  };
  // D-085: API returns roundsPlayed/roundsWon (not rounds/wins) — map them so
  // the profile actually shows today's numbers.
  const { data: session } = useQuery({
    queryKey: ['session-stats'],
    queryFn: async () => {
      const d = await http.get<{
        roundsPlayed?: number;
        roundsWon?: number;
        net?: number;
        biggestWin?: number;
      }>('/user/session-stats');
      return {
        rounds: d.roundsPlayed ?? 0,
        wins: d.roundsWon ?? 0,
        net: d.net ?? 0,
        biggestWin: d.biggestWin ?? 0,
      };
    },
  });

  return (
    <div className="p-6 max-w-md mx-auto space-y-4">
      <h1 className="t-title text-primary">Profile</h1>
      <div className="rounded-xl bg-layer-surface border border-white/8 p-4 flex items-center gap-3">
        <div className="w-16 h-16 rounded-full bg-layer-elevated flex items-center justify-center t-title text-gold">
          {me?.displayName?.[0] ?? 'P'}
        </div>
        <div>
          <p className="t-label-lg text-primary">{me?.displayName || 'Player'}</p>
          <p className="t-label-sm text-secondary">{me?.phone}</p>
        </div>
      </div>

      <div className="rounded-xl bg-layer-surface border border-white/8 p-4">
        <p className="t-label-md text-secondary mb-3">Today's Session</p>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Rounds" value={String(session?.rounds ?? 0)} />
          <Stat label="Wins" value={String(session?.wins ?? 0)} />
          <Stat
            label="Net P&L"
            value={`${process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}${session?.net ?? 0}`}
          />
          <Stat
            label="Biggest win"
            value={`${process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}${session?.biggestWin ?? 0}`}
          />
        </div>
      </div>

      <div className="rounded-xl bg-layer-surface border border-white/8 p-4 space-y-3">
        <h2 className="t-label-lg text-primary">Responsible play</h2>
        <p className="t-label-sm text-muted">
          Limits are enforced by the server on every real-money request. Leave an amount
          blank to remove that limit.
        </p>
        <label className="block t-label-sm text-secondary">
          Daily loss limit
          <input
            type="number"
            min="0"
            value={lossLimit}
            onChange={(event) => setLossLimit(event.target.value)}
            placeholder={String(me?.dailyLossLimit ?? 'No limit')}
            className="mt-1 w-full h-10 rounded-lg bg-layer-elevated border border-white/10 px-3"
          />
        </label>
        <label className="block t-label-sm text-secondary">
          Daily deposit limit
          <input
            type="number"
            min="0"
            value={depositLimit}
            onChange={(event) => setDepositLimit(event.target.value)}
            placeholder={String(me?.dailyDepositLimit ?? 'No limit')}
            className="mt-1 w-full h-10 rounded-lg bg-layer-elevated border border-white/10 px-3"
          />
        </label>
        <label className="block t-label-sm text-secondary">
          Break reminder (minutes; 0 disables)
          <input
            type="number"
            min="0"
            max="480"
            value={reminder}
            onChange={(event) => setReminder(event.target.value)}
            placeholder={String(me?.sessionReminderMin ?? 60)}
            className="mt-1 w-full h-10 rounded-lg bg-layer-elevated border border-white/10 px-3"
          />
        </label>
        <button
          onClick={saveLimits}
          disabled={responsible.isPending}
          className="btn-primary w-full"
        >
          Save limits
        </button>
        <div className="pt-3 border-t border-white/8">
          <p className="t-label-md text-red mb-2">Self-exclusion</p>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => exclude(24)} className="btn-danger h-10">
              24 hours
            </button>
            <button onClick={() => exclude(24 * 7)} className="btn-danger h-10">
              7 days
            </button>
            <button onClick={() => exclude(24 * 30)} className="btn-danger h-10">
              30 days
            </button>
            <button onClick={() => exclude(24 * 365)} className="btn-danger h-10">
              Permanent
            </button>
          </div>
        </div>
      </div>

      <SecuritySection />

      <div className="rounded-xl bg-layer-surface border border-white/8 p-4 space-y-3">
        <a
          href="/provably-fair"
          className="flex items-center justify-between t-label-md text-gold"
        >
          ✓ Provably Fair Verifier →
        </a>
      </div>
    </div>
  );
}

// ── LEGAL PAGE RENDERER (v4 legal/[slug]) ──────────────────────────────────
export function LegalPageView({ slug }: { slug: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['legal', slug],
    queryFn: () => http.get<{ title: string; content: string }>(`/legal/${slug}`),
  });
  if (isLoading)
    return (
      <div className="p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 mt-4" />
      </div>
    );
  return (
    <article className="p-6 max-w-2xl mx-auto prose-invert">
      <h1 className="t-title text-primary mb-4">{data?.title}</h1>
      {/* D-078: sanitized server-side (apps/api/src/lib/sanitize.ts) before this renders */}
      <div
        className="t-body text-secondary whitespace-pre-wrap"
        dangerouslySetInnerHTML={{ __html: data?.content ?? '' }}
      />
    </article>
  );
}

// ── DAILY CHECK-IN CALENDAR (v4 + docs/19 §16 ladder) ──────────────────────
export function DailyCheckinCalendar() {
  const user = useAuthStore((s) => s.user);
  const { data } = useQuery({
    queryKey: ['checkin'],
    queryFn: () =>
      http.get<{ streak: number; claimedToday: boolean; history: string[] }>(
        '/bonuses/streak-status'
      ),
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
      invalidate.balance();
      invalidate.sessionStats();
      invalidate.checkin();
      invalidate.transactions();
    },
    onError: (e) => notify.error((e as Error).message),
  });

  // D-072: guests get a signup CTA instead of an authed call
  if (!user) {
    return (
      <div className="rounded-xl bg-layer-surface border border-gold/25 p-6 text-center">
        <p className="text-3xl mb-2">🎁</p>
        <p className="t-label-lg text-primary mb-1">Daily Check-in</p>
        <p className="t-body text-secondary mb-4">
          Log in daily, claim free coins, grow your streak.
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
    );
  }

  const days = Array.from({ length: 7 }, (_, i) => i + 1);
  return (
    <div className="rounded-xl bg-layer-surface border border-white/8 p-4">
      <div className="flex items-center justify-between mb-4">
        <p className="t-label-lg text-primary">Daily Check-in</p>
        <p className="t-label-md text-gold">🔥 {data?.streak ?? 0}</p>
      </div>
      <div className="grid grid-cols-7 gap-2 mb-4">
        {days.map((d) => {
          const claimed = data?.history?.includes(String(d));
          const isToday = d === (data?.streak ?? 0) + 1 && !data?.claimedToday;
          return (
            <div
              key={d}
              className={`aspect-square rounded-full flex items-center justify-center t-label-md
              ${claimed ? 'bg-gold/20 border border-gold/40 text-gold' : isToday ? 'bg-gold text-[#3d2800] animate-pulse-gold' : 'bg-layer-elevated text-white/40'}`}
            >
              {claimed ? '✓' : d}
            </div>
          );
        })}
      </div>
      <button
        disabled={data?.claimedToday || claim.isPending}
        onClick={() => claim.mutate()}
        className="btn-primary w-full"
      >
        {data?.claimedToday ? 'Claimed ✓' : 'Claim Today'}
      </button>
    </div>
  );
}

// ── SECURITY (change password / sign out everywhere) ────────────────────────
// Added with the hardening pass: until now a player had NO way to change their
// password from inside the product, and no way to kick an intruder off their
// other devices.
function SecuritySection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const changePassword = useMutation({
    mutationFn: () =>
      http.post<{ sessionsRevoked: number }>('/auth/change-password', {
        currentPassword,
        newPassword,
      }),
    onSuccess: (r) => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setFormError(null);
      notify.success(
        r.sessionsRevoked > 0
          ? `Password changed — ${r.sessionsRevoked} other device(s) signed out`
          : 'Password changed'
      );
    },
    onError: (e) => setFormError((e as Error).message),
  });

  const logoutAll = useMutation({
    mutationFn: () => http.post<{ sessionsRevoked: number }>('/auth/logout-all'),
    onSuccess: () => {
      notify.success('All devices signed out');
      useAuthStore.getState().logout();
      window.location.href = '/login';
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit =
    !changePassword.isPending &&
    currentPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword;

  return (
    <div className="rounded-xl bg-layer-surface border border-white/8 p-4 space-y-3">
      <h2 className="t-label-lg text-primary">Security</h2>

      <div className="space-y-2">
        <p className="t-label-md text-secondary">Change password</p>
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="Current password"
          autoComplete="current-password"
          className="w-full h-11 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none t-label-md"
        />
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="New password (8+ characters, letters + numbers)"
          autoComplete="new-password"
          className="w-full h-11 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none t-label-md"
        />
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Repeat new password"
          autoComplete="new-password"
          className="w-full h-11 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none t-label-md"
        />
        {mismatch && <p className="t-label-sm text-red">Passwords do not match</p>}
        {formError && (
          <p className="t-label-sm text-red bg-red/10 border border-red/25 rounded-lg px-3 py-2">
            {formError}
          </p>
        )}
        <button
          disabled={!canSubmit}
          onClick={() => changePassword.mutate()}
          className="btn-primary w-full disabled:opacity-50"
        >
          {changePassword.isPending ? 'Changing…' : 'Change password'}
        </button>
        <p className="t-label-sm text-muted">
          Changing your password signs out every other device and keeps you signed in here.
        </p>
      </div>

      <div className="border-t border-white/10 pt-3 space-y-2">
        <p className="t-label-md text-secondary">Signed in somewhere you don&apos;t recognise?</p>
        <button
          disabled={logoutAll.isPending}
          onClick={() => {
            if (
              window.confirm(
                'Sign out of every device, including this one? You will need to log in again.'
              )
            )
              logoutAll.mutate();
          }}
          className="w-full h-11 rounded-lg border border-red/40 bg-red/10 text-red t-label-md hover:bg-red/20 disabled:opacity-50"
        >
          {logoutAll.isPending ? 'Signing out…' : 'Sign out of all devices'}
        </button>
        <p className="t-label-sm text-muted">
          Lost your password entirely? Use{' '}
          <a href="/recovery" className="text-gold underline underline-offset-2">
            account recovery
          </a>{' '}
          — it works without an email or OTP.
        </p>
      </div>
    </div>
  );
}
