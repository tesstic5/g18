// apps/web/src/app/(auth)/login/page.tsx — docs/19 §4 LOGIN (centered card, +92 default)
// D-082: field-level validation + smart server-error mapping + loading states.
'use client';
import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { http } from '../../../lib/api';
import { authSessionDto, type AuthSession } from '../../../lib/dto';
import {
  normalizePhone,
  describePhoneProblem,
  formatPhone,
} from '@casino/shared/utils/phone';
import { useAuthStore, refreshBalance } from '../../../stores';
import { t, detectLang } from '../../../lib/i18n';
import { notify } from '../../../lib/toast';
import { friendlyAuthError } from '../../../lib/auth-errors';

export default function LoginPage() {
  // useSearchParams must be inside Suspense during static prerender (Next 16)
  return (
    <Suspense fallback={<div className="min-h-dvh bg-layer-floor" />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = params.get('redirect') || '/'; // return where the user was
  const lang = detectLang();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{
    phone?: string;
    password?: string;
    form?: string;
  }>({});
  const [loading, setLoading] = useState(false);

  // D-083: accept ANY format — 03001234567, +923001234567, 92…, 300…
  const normalized = normalizePhone(phone);
  const phoneValid = !!normalized;
  // The button is NEVER disabled for a validation reason. It used to be gated
  // on `normalizePhone()` returning a value, so anyone whose number the parser
  // did not understand (e.g. 0092..., +92 0300...) saw a permanently greyed-out
  // button with no explanation and simply could not sign in. Now the form
  // always submits and tells them exactly what to fix.
  const canSubmit = !loading;

  const validate = (): boolean => {
    const e: typeof errors = {};
    const phoneProblem = describePhoneProblem(phone);
    if (phoneProblem) e.phone = phoneProblem;
    if (!password) e.password = 'Enter your password';
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
        '/auth/login',
        { phone: normalized!, password, fingerprint: fp },
        { schema: authSessionDto }
      );
      useAuthStore.getState().setSession(res.user, res.accessToken);
      notify.success('Welcome back');
      void refreshBalance().catch(() => {});
      router.push(
        redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/'
      );
    } catch (err) {
      // D-082 + D-103: map server errors to clear messages (incl. DB
      // unavailable 503s during restarts and generic 500s with a reference)
      setErrors({ form: friendlyAuthError(err) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-layer-floor px-6 py-8">
      <div className="w-full max-w-[400px]">
        <div className="text-center mb-8">
          <img
            src="/icons/logo.svg"
            alt={process.env.NEXT_PUBLIC_PLATFORM_NAME || '2 Win 2 Play'}
            className="w-24 h-24 mx-auto mb-4 drop-shadow-[0_8px_24px_rgba(245,200,66,0.25)]"
          />
          <h1 className="t-title text-primary">
            {process.env.NEXT_PUBLIC_PLATFORM_NAME || '2 Win 2 Play'}
          </h1>
          <p className="t-label-md text-secondary">
            {process.env.NEXT_PUBLIC_PLATFORM_TAGLINE || 'Play. Win. Repeat.'}
          </p>
        </div>

        <div className="rounded-2xl bg-layer-surface border border-white/8 p-6">
          <h2 className="t-label-xl text-primary">{t(lang, 'auth.welcomeBack')}</h2>
          <p className="t-label-md text-secondary mb-6">
            {t(lang, 'auth.signInToAccount')}
          </p>

          <form onSubmit={submit} noValidate className="space-y-4">
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
                    if (errors.phone) setErrors((s) => ({ ...s, phone: undefined }));
                  }}
                  inputMode="tel"
                  maxLength={20}
                  placeholder="0300 1234567"
                  autoComplete="tel"
                  className={`flex-1 px-3 bg-transparent outline-none t-num-lg ${phoneValid ? 'text-green' : ''}`}
                />
              </div>
              {phone && !phoneValid && !errors.phone && (
                <span className="t-label-sm text-muted block mt-1">
                  We'll use +92… — any format works (0300…, +92…)
                </span>
              )}
              {phoneValid && (
                <span className="t-label-sm text-green block mt-1">
                  ✓ We&apos;ll use {formatPhone(phone)}
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
                  if (errors.password)
                    setErrors((s) => ({ ...s, password: undefined }));
                }}
                autoComplete="current-password"
                className={`w-full h-12 px-3 rounded-lg bg-layer-elevated border outline-none focus:border-gold/40 ${errors.password ? 'border-red/60' : 'border-white/10'}`}
              />
              {errors.password && (
                <span className="t-label-sm text-red block mt-1">
                  {errors.password}
                </span>
              )}
            </label>

            {errors.form && (
              <p className="t-label-sm text-red bg-red/10 border border-red/25 rounded-lg px-3 py-2">
                {errors.form}
              </p>
            )}

            <button
              disabled={!canSubmit}
              className="btn-gold w-full !rounded-xl shadow-[0_4px_24px_rgba(245,200,66,0.35)] relative overflow-hidden disabled:opacity-50"
            >
              {/* D-102: shine sweep — consistent with the site's CTA feel */}
              {!loading && (
                <span className="absolute inset-y-0 left-0 w-1/3 -skew-x-12 bg-white/25 blur-[6px] animate-btn-shine pointer-events-none" />
              )}
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-4 w-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />{' '}
                  Signing in…
                </span>
              ) : (
                <span className="inline-flex items-center justify-center gap-2">
                  🔑 {t(lang, 'auth.signIn')}
                </span>
              )}
            </button>
          </form>

          <div className="text-center mt-6">
            <p className="t-label-md text-secondary">
              {t(lang, 'auth.dontHaveAccount')}{' '}
              <Link
                href="/signup"
                className="text-gold underline underline-offset-2 decoration-gold/70"
              >
                {t(lang, 'auth.signUp')}
              </Link>
            </p>
            {/* Recovery console (routes/recovery.ts): no email or OTP on this
                platform, so a locked-out player needs a way in that does not
                require being logged in. */}
            <p className="t-label-sm mt-3">
              <Link
                href="/recovery"
                className="text-white/60 underline underline-offset-2 hover:text-gold transition-colors"
              >
                Can&apos;t log in? Recover your account
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
