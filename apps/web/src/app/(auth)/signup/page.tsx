// apps/web/src/app/(auth)/signup/page.tsx — docs/19 §4 SIGNUP (referral ?ref= prefill, strength meter)
// D-082: field-level validation, live hints, smart server-error mapping.
'use client';
import React, { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { http } from '../../../lib/api';
import { authSessionDto, type AuthSession } from '../../../lib/dto';
import { normalizePhone, describePhoneProblem } from '@casino/shared/utils/phone';
import { useAuthStore, refreshBalance } from '../../../stores';
import { t, detectLang } from '../../../lib/i18n';
import { friendlyAuthError } from '../../../lib/auth-errors';
import { notify } from '../../../lib/toast';

// ── invite-code persistence ───────────────────────────────────────────────
// The ref used to live only in the URL: tap "Log in", browse to the lobby, or
// come back later and the referrer silently lost their reward. Park it in a
// cookie so it survives the visit, and clear it once the account exists.
const REF_COOKIE = 'ref';
const REF_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

function readRefCookie(): string {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(/(?:^|;\s*)ref=([^;]*)/);
  const raw = m?.[1];
  return raw ? decodeURIComponent(raw) : '';
}

function writeRefCookie(code: string): void {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `ref=${encodeURIComponent(code)}; path=/; max-age=${REF_MAX_AGE}; SameSite=Lax${secure}`;
}

function clearRefCookie(): void {
  document.cookie = `ref=; path=/; max-age=0; SameSite=Lax`;
}

export default function SignupPage() {
  // useSearchParams must render inside a Suspense boundary during static
  // prerender (Next 16 — otherwise `next build` fails on this page).
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center bg-layer-floor">
          <div className="h-6 w-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        </div>
      }
    >
      <SignupForm />
    </Suspense>
  );
}

function SignupForm() {
  const router = useRouter();
  const lang = detectLang();
  const params = useSearchParams();
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [referral, setReferral] = useState(params.get('ref') ?? '');

  // Remember the invite code for later in the visit, and restore one captured
  // earlier if this page is reached without ?ref= in the URL.
  useEffect(() => {
    const fromUrl = params.get('ref')?.trim();
    if (fromUrl) {
      writeRefCookie(fromUrl);
      return;
    }
    const saved = readRefCookie();
    if (saved) setReferral((cur) => cur || saved);
  }, [params]);
  const [agree, setAgree] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const strength = useMemo(() => {
    let s = 0;
    if (password.length >= 8) s++;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) s++;
    if (/\d/.test(password)) s++;
    if (/[^A-Za-z0-9]/.test(password)) s++;
    return s;
  }, [password]);

  const normalizedPhone = normalizePhone(phone);
  const phoneValid = !!normalizedPhone;
  // Never disabled for a validation reason — pressing it explains what to fix.
  // (Same lockout the login page had: a number the parser didn't understand
  // left the user staring at a dead button.)
  const valid = !loading;

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    const name = displayName.trim();
    if (name && name.length < 2) e.displayName = 'Name must be at least 2 characters';
    else if (name && !/^[a-zA-Z0-9 ]+$/.test(name))
      e.displayName = 'Letters, numbers and spaces only';
    const phoneProblem = describePhoneProblem(phone);
    if (phoneProblem) e.phone = phoneProblem;
    if (!password) e.password = 'Create a password';
    else if (password.length < 8) e.password = 'At least 8 characters';
    else if (strength < 2) e.password = 'Make it stronger: add numbers or symbols';
    if (confirm !== password) e.confirm = 'Passwords do not match';
    if (!agree) e.agree = 'You must accept the terms to continue';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    setErrors({});
    try {
      const fp = {
        userAgent: navigator.userAgent,
        screenRes: `${screen.width}x${screen.height}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
      };
      const res = await http.post<AuthSession>(
        '/auth/signup',
        {
          phone: normalizedPhone!,
          password,
          displayName: displayName.trim() || undefined,
          fingerprint: fp,
          referralCode: referral.trim() || undefined,
        },
        { schema: authSessionDto }
      );
      useAuthStore.getState().setSession(res.user, res.accessToken);
      // The account exists — the invite code has done its job either way.
      clearRefCookie();
      notify.success('Welcome to 2 Win 2 Play! 🎉');
      // Deliberately NOT an error: an unknown code never blocks registration
      // any more, so tell them plainly rather than failing the signup.
      if (res.referralApplied === false && referral.trim()) {
        notify.info(
          `Invite code "${referral.trim()}" wasn't recognised — you're signed up without it.`
        );
      }
      void refreshBalance().catch(() => {});
      router.push('/wallet?mode=deposit'); // land straight on the deposit flow
    } catch (err) {
      // D-082 + D-103: map server errors to clear messages (incl. DB
      // unavailable 503s during restarts and generic 500s with a reference)
      const msg = friendlyAuthError(err);
      // field-specific errors keep their placement; the rest go to the form line
      if (msg === 'This phone number is already registered — try logging in')
        setErrors({ phone: msg });
      else if (msg === 'That referral code is not valid') setErrors({ referral: msg });
      else setErrors({ form: msg });
    } finally {
      setLoading(false);
    }
  };

  const clearErr = (k: string) =>
    setErrors((s) => (s[k] ? { ...s, [k]: undefined! } : s));
  const inputCls = (k: string) =>
    `w-full h-12 px-3 rounded-lg bg-layer-elevated border outline-none focus:border-gold/40 transition-colors ${errors[k] ? 'border-red/60' : 'border-white/10'}`;

  return (
    <div className="min-h-dvh flex items-center justify-center bg-layer-floor px-6 py-8">
      <div className="w-full max-w-[400px]">
        <div className="text-center mb-6">
          <img
            src="/icons/logo.svg"
            alt={process.env.NEXT_PUBLIC_PLATFORM_NAME || '2 Win 2 Play'}
            className="w-20 h-20 mx-auto mb-4 drop-shadow-[0_8px_24px_rgba(245,200,66,0.25)]"
          />
          <h1 className="t-title text-primary">{t(lang, 'auth.createAccount')}</h1>
          <p className="t-label-md text-secondary">{t(lang, 'auth.joinThousands')}</p>
        </div>

        <div className="rounded-2xl bg-layer-surface border border-white/8 p-6">
          <form onSubmit={submit} noValidate className="space-y-4">
            <label className="block">
              <span className="t-label-md text-secondary block mb-2">
                {t(lang, 'auth.displayName')}
              </span>
              <input
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  clearErr('displayName');
                }}
                maxLength={24}
                className={inputCls('displayName')}
              />
              {errors.displayName && (
                <span className="t-label-sm text-red block mt-1">
                  {errors.displayName}
                </span>
              )}
            </label>
            <label className="block">
              <span className="t-label-md text-secondary block mb-2">
                {t(lang, 'auth.phone')}
              </span>
              <div
                className={`flex h-12 rounded-lg overflow-hidden border bg-layer-elevated focus-within:border-gold/40 transition-colors ${errors.phone ? 'border-red/60' : 'border-white/10'}`}
              >
                <input
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    clearErr('phone');
                  }}
                  inputMode="tel"
                  maxLength={20}
                  autoComplete="tel"
                  placeholder="0300 1234567"
                  className={`flex-1 px-3 bg-transparent outline-none t-num-lg ${phoneValid ? 'text-green' : ''}`}
                />
              </div>
              {phone && !phoneValid && !errors.phone && (
                <span className="t-label-sm text-muted block mt-1">
                  Any format works: 0300…, +92 300…, 92 300…
                </span>
              )}
              {phoneValid && (
                <span className="t-label-sm text-green block mt-1">
                  ✓ +92 {normalizedPhone!.slice(3, 6)} {normalizedPhone!.slice(6)}
                </span>
              )}
              {errors.phone && (
                <span className="t-label-sm text-red block mt-1">{errors.phone}</span>
              )}
            </label>
            <label className="block">
              <span className="t-label-md text-secondary block mb-2">
                {t(lang, 'auth.password')}
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  clearErr('password');
                }}
                autoComplete="new-password"
                className={inputCls('password')}
              />
              {password && (
                <span
                  className={`block mt-1.5 t-label-sm ${strength <= 1 ? 'text-red' : strength <= 3 ? 'text-gold' : 'text-green'}`}
                >
                  {'█'.repeat(strength)}
                  {'░'.repeat(4 - strength)}{' '}
                  {strength <= 1 ? 'Weak' : strength <= 3 ? 'Medium' : 'Strong'}
                </span>
              )}
              {errors.password && (
                <span className="t-label-sm text-red block mt-1">
                  {errors.password}
                </span>
              )}
            </label>
            <label className="block">
              <span className="t-label-md text-secondary block mb-2">
                {t(lang, 'auth.confirmPassword')}
              </span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  clearErr('confirm');
                }}
                autoComplete="new-password"
                className={inputCls('confirm')}
              />
              {confirm && confirm !== password && !errors.confirm && (
                <span className="t-label-sm text-red block mt-1.5">
                  Passwords do not match
                </span>
              )}
              {errors.confirm && (
                <span className="t-label-sm text-red block mt-1">{errors.confirm}</span>
              )}
            </label>
            <label className="block">
              <span className="t-label-md text-secondary block mb-2">
                {t(lang, 'auth.referralCode')}
              </span>
              <input
                value={referral}
                onChange={(e) => {
                  setReferral(e.target.value);
                  clearErr('referral');
                }}
                maxLength={32}
                className={inputCls('referral')}
              />
              {referral && !errors.referral && (
                <span className="t-label-sm text-gold block mt-1.5">
                  🎁 Referred by a friend
                </span>
              )}
              {errors.referral && (
                <span className="t-label-sm text-red block mt-1">
                  {errors.referral}
                </span>
              )}
            </label>
            <label className="flex items-start gap-2 t-label-sm text-secondary">
              <input
                type="checkbox"
                checked={agree}
                onChange={(e) => {
                  setAgree(e.target.checked);
                  clearErr('agree');
                }}
                className="mt-0.5 accent-gold"
              />
              <span>{t(lang, 'auth.agreeToTerms')}</span>
            </label>
            {errors.agree && <p className="t-label-sm text-red">{errors.agree}</p>}
            {errors.form && (
              <p className="t-label-sm text-red bg-red/10 border border-red/25 rounded-lg px-3 py-2">
                {errors.form}
              </p>
            )}
            <button
              disabled={!valid}
              className="btn-gold w-full !rounded-xl shadow-[0_4px_24px_rgba(245,200,66,0.35)] relative overflow-hidden disabled:opacity-50"
            >
              {/* D-102: shine sweep — consistent with the site's CTA feel */}
              {!loading && (
                <span className="absolute inset-y-0 left-0 w-1/3 -skew-x-12 bg-white/25 blur-[6px] animate-btn-shine pointer-events-none" />
              )}
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-4 w-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />{' '}
                  Creating account…
                </span>
              ) : (
                <span className="inline-flex items-center justify-center gap-2">
                  🚀 {t(lang, 'auth.createAccount')}
                </span>
              )}
            </button>
          </form>
          <p className="text-center t-label-md text-secondary mt-5">
            {t(lang, 'auth.alreadyHaveAccount')}{' '}
            <Link
              href="/login"
              className="text-gold underline underline-offset-2 decoration-gold/70"
            >
              {t(lang, 'auth.signIn')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
