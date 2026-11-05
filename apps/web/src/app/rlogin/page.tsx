// apps/web/src/app/rlogin/page.tsx — referral agent login,
// styled to match the admin/player auth screens (gold CTA, surface card).
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiBaseUrl } from '../../lib/env';
import { Card, Field, TextInput, ActionBtn, Icon } from '../../components/admin/ui';

const TOKEN_KEY = 'referral_agent_token';
const PLATFORM = process.env.NEXT_PUBLIC_PLATFORM_NAME || '2 Win 2 Play';

export default function ReferralLoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${apiBaseUrl()}/referral-panel/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password }),
      });
      const json = (await res.json().catch(() => null)) as {
        data?: { token?: string };
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.data?.token) {
        setError(json?.error?.message || 'Invalid phone or password');
        return;
      }
      localStorage.setItem(TOKEN_KEY, json.data.token);
      router.push('/referral-panel');
    } catch {
      setError('Network error — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <span className="h-11 w-11 rounded-xl bg-gold/12 text-gold flex items-center justify-center mb-3">
            <Icon name="gift" size={22} />
          </span>
          <h1 className="t-num-xl text-primary">{PLATFORM}</h1>
          <p className="t-label-md text-secondary mt-1">Referral Partner Login</p>
        </div>
        <Card>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Phone">
              <TextInput
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0300XXXXXXX"
                required
                autoComplete="username"
              />
            </Field>
            <Field label="Password">
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </Field>
            {error && <p className="t-label-sm text-red">{error}</p>}
            <div className="flex justify-center">
              <ActionBtn tone="gold" type="submit" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </ActionBtn>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
