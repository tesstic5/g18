// apps/web/src/app/(auth)/recovery/page.tsx — PUBLIC lockout page.
//
// The only page reachable by someone who cannot log in, so it must work with
// no session at all. Two jobs:
//   1. file a recovery request and hand the player their TICKET code,
//   2. let them follow the thread and collect the one-time RECOVERY code.
//
// The ticket code is never sent by email or SMS (this platform has neither) —
// the player keeps it, and it is the only key to this page.
'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { http } from '../../../lib/api';
import { notify } from '../../../lib/toast';
import { normalizePhone } from '@casino/shared/utils/phone';

interface RequestResult {
  ticket: string;
  status: string;
  statusLabel: string;
  createdAt: string;
}
interface ThreadMessage {
  from: 'PLAYER' | 'SUPPORT';
  body: string;
  at: string;
}
interface StatusResult {
  status: string;
  statusLabel: string;
  createdAt: string;
  updatedAt: string;
  messages: ThreadMessage[];
  code: string | null;
  codeExpiresAt: string | null;
  freezeUntil: string | null;
  freezeNotice: string | null;
  rejectReason: string | null;
  attemptsLeft: number;
}

const STATUS_TONE: Record<string, string> = {
  PENDING: 'text-white/80 border-white/20',
  IN_REVIEW: 'text-sky border-sky/40',
  VERIFIED: 'text-sky border-sky/40',
  APPROVED: 'text-green border-green/40',
  REDEEMED: 'text-green border-green/40',
  REJECTED: 'text-red border-red/40',
  EXPIRED: 'text-orange border-orange/40',
};

export default function RecoveryPage() {
  const [tab, setTab] = useState<'request' | 'status'>('request');
  const [ticket, setTicket] = useState('');
  const [issued, setIssued] = useState<RequestResult | null>(null);

  // ── request form ─────────────────────────────────────────────────────────
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [lastDepositRef, setLastDepositRef] = useState('');
  const [senderAccount, setSenderAccount] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      http.post<RequestResult>('/recovery/request', {
        phone,
        message: message || undefined,
        answers: {
          lastDepositRef: lastDepositRef || undefined,
          senderAccount: senderAccount || undefined,
        },
      }),
    onSuccess: (r) => {
      setIssued(r);
      setTicket(r.ticket);
      notify.success('Recovery request filed');
    },
    onError: (e) => setFormError((e as Error).message),
  });

  // ── status + redeem ──────────────────────────────────────────────────────
  const trimmedTicket = ticket.trim();
  const {
    data: status,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ['recovery-status', trimmedTicket],
    queryFn: () => http.post<StatusResult>('/recovery/status', { ticket: trimmedTicket }),
    enabled: tab === 'status' && trimmedTicket.length >= 8,
    refetchInterval: 20000,
    retry: false,
  });

  const [reply, setReply] = useState('');
  const sendReply = useMutation({
    mutationFn: () => http.post('/recovery/message', { ticket: trimmedTicket, body: reply }),
    onSuccess: () => {
      setReply('');
      refetch();
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const redeem = useMutation({
    mutationFn: () =>
      http.post<{ sessionsRevoked: number; freezeUntil: string | null }>('/recovery/redeem', {
        ticket: trimmedTicket,
        code: status?.code ?? '',
        newPassword,
      }),
    onSuccess: (r) => {
      setNewPassword('');
      setConfirmPassword('');
      notify.success(
        r.freezeUntil
          ? 'Password changed. Withdrawals stay on hold while we finish protecting your account.'
          : 'Password changed — you can log in now'
      );
      refetch();
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const canSubmit = !submit.isPending && normalizePhone(phone) !== null;
  const passwordMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  return (
    <div className="min-h-dvh flex items-start justify-center bg-layer-floor px-4 py-10">
      <div className="w-full max-w-[520px]">
        <div className="text-center mb-6">
          <img
            src="/icons/logo.svg"
            alt={process.env.NEXT_PUBLIC_PLATFORM_NAME || '2 Win 2 Play'}
            className="w-20 h-20 mx-auto mb-3 drop-shadow-[0_8px_24px_rgba(245,200,66,0.25)]"
          />
          <h1 className="t-title text-primary">Account recovery</h1>
          <p className="t-label-md text-secondary mt-1">
            Locked out? File a request and an agent will verify you — no email or OTP needed.
          </p>
        </div>

        <div className="flex gap-2 mb-4">
          {(['request', 'status'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 h-10 rounded-xl t-label-md border transition-colors ${
                tab === t
                  ? 'border-gold/60 bg-gold/10 text-gold'
                  : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
              }`}
            >
              {t === 'request' ? 'File a request' : 'Check my request'}
            </button>
          ))}
        </div>

        {tab === 'request' && (
          <div className="rounded-2xl bg-layer-surface border border-white/8 p-6 space-y-4">
            {issued ? (
              <div className="space-y-4">
                <div className="rounded-xl border border-gold/40 bg-gold/10 p-4">
                  <p className="t-label-sm text-gold uppercase tracking-wide mb-1">
                    Your ticket code — save it now
                  </p>
                  <p className="t-num-lg text-white break-all">{issued.ticket}</p>
                  <p className="t-label-sm text-secondary mt-2">
                    This is the only way to check progress and to collect your new-password code.
                    It is shown once and cannot be recovered — screenshot it or write it down.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => navigator.clipboard?.writeText(issued.ticket)}
                    className="btn-gold !rounded-xl px-4 h-10"
                  >
                    Copy code
                  </button>
                  <button
                    onClick={() => setTab('status')}
                    className="h-10 px-4 rounded-xl border border-white/15 bg-white/5 t-label-md text-white/80 hover:bg-white/10"
                  >
                    Check my request
                  </button>
                </div>
                <p className="t-label-sm text-muted">
                  An agent reviews your request and may ask questions in the thread. Keep the code
                  safe until you are back in your account.
                </p>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setFormError(null);
                  submit.mutate();
                }}
                className="space-y-4"
              >
                <label className="block">
                  <span className="t-label-md text-secondary block mb-2">
                    The mobile number on your account
                  </span>
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    inputMode="tel"
                    maxLength={20}
                    placeholder="0300 1234567"
                    className="w-full h-12 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none t-num-lg"
                  />
                </label>

                <label className="block">
                  <span className="t-label-md text-secondary block mb-2">
                    What happened? (optional)
                  </span>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    maxLength={2000}
                    rows={3}
                    placeholder="I forgot my password / my phone was stolen…"
                    className="w-full px-3 py-2.5 rounded-lg bg-layer-elevated border border-white/10 outline-none t-label-md"
                  />
                </label>

                <div className="rounded-xl border border-white/10 bg-white/3 p-3 space-y-3">
                  <p className="t-label-sm text-secondary">
                    Details only you would know — this is how the agent verifies you. The more you
                    give, the faster it goes.
                  </p>
                  <input
                    value={lastDepositRef}
                    onChange={(e) => setLastDepositRef(e.target.value)}
                    maxLength={64}
                    placeholder="Last deposit reference number"
                    className="w-full h-11 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none t-label-md"
                  />
                  <input
                    value={senderAccount}
                    onChange={(e) => setSenderAccount(e.target.value)}
                    maxLength={64}
                    placeholder="Account you paid from (JazzCash / bank)"
                    className="w-full h-11 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none t-label-md"
                  />
                </div>

                {formError && (
                  <p className="t-label-sm text-red bg-red/10 border border-red/25 rounded-lg px-3 py-2">
                    {formError}
                  </p>
                )}

                <button
                  disabled={!canSubmit}
                  className="btn-gold w-full !rounded-xl disabled:opacity-50"
                >
                  {submit.isPending ? 'Filing…' : 'File recovery request'}
                </button>
                <p className="t-label-sm text-muted text-center">
                  You will get a ticket code on the next screen. Support never asks for your
                  password.
                </p>
              </form>
            )}
          </div>
        )}

        {tab === 'status' && (
          <div className="rounded-2xl bg-layer-surface border border-white/8 p-6 space-y-4">
            <label className="block">
              <span className="t-label-md text-secondary block mb-2">Your ticket code</span>
              <input
                value={ticket}
                onChange={(e) => setTicket(e.target.value)}
                placeholder="TKT-XXXX-XXXX-XXXX"
                className="w-full h-12 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none t-num-lg tracking-wide"
              />
            </label>

            {status && (
              <>
                <div
                  className={`rounded-xl border px-4 py-3 ${
                    STATUS_TONE[status.status] ?? 'text-white/80 border-white/20'
                  }`}
                >
                  <p className="t-label-md">{status.statusLabel}</p>
                  {status.status === 'APPROVED' && status.codeExpiresAt && (
                    <p className="t-label-sm text-secondary mt-1">
                      Your code must be used before{' '}
                      {new Date(status.codeExpiresAt).toLocaleTimeString()} ({status.attemptsLeft}{' '}
                      attempts left).
                    </p>
                  )}
                  {status.rejectReason && (
                    <p className="t-label-sm mt-1">Reason: {status.rejectReason}</p>
                  )}
                </div>

                {status.freezeNotice && (
                  <p className="t-label-sm text-orange bg-orange/10 border border-orange/25 rounded-lg px-3 py-2">
                    🔒 {status.freezeNotice}
                  </p>
                )}

                {status.code && (
                  <div className="rounded-xl border border-green/40 bg-green/10 p-4 space-y-3">
                    <p className="t-label-sm text-green uppercase tracking-wide">
                      Your recovery code
                    </p>
                    <p className="t-num-lg text-white break-all">{status.code}</p>
                    <p className="t-label-sm text-secondary">
                      Set your new password below. This code works once and never appears again.
                    </p>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="New password (8+ characters)"
                      className="w-full h-11 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none t-label-md"
                    />
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Repeat new password"
                      className="w-full h-11 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none t-label-md"
                    />
                    {passwordMismatch && (
                      <p className="t-label-sm text-red">Passwords do not match</p>
                    )}
                    <button
                      disabled={
                        redeem.isPending ||
                        newPassword.length < 8 ||
                        newPassword !== confirmPassword
                      }
                      className="btn-gold w-full !rounded-xl disabled:opacity-50"
                      onClick={() => redeem.mutate()}
                    >
                      {redeem.isPending ? 'Setting password…' : 'Set new password'}
                    </button>
                    <p className="t-label-sm text-muted">
                      All devices will be signed out and withdrawals stay paused for a short while —
                      that is what keeps a stolen account from being emptied.
                    </p>
                  </div>
                )}

                {status.messages.length > 0 && (
                  <div className="space-y-2">
                    <p className="t-label-sm text-secondary uppercase tracking-wide">
                      Messages with support
                    </p>
                    <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
                      {status.messages.map((m, i) => (
                        <div
                          key={`${m.at}-${i}`}
                          className={`rounded-xl px-3 py-2 t-label-sm ${
                            m.from === 'SUPPORT'
                              ? 'bg-white/5 text-white/85 border border-white/10'
                              : 'bg-gold/10 border border-gold/25 text-white/85 ml-6'
                          }`}
                        >
                          <p className="t-label-sm text-muted mb-1">
                            {m.from === 'SUPPORT' ? 'Support' : 'You'} ·{' '}
                            {new Date(m.at).toLocaleString()}
                          </p>
                          <p className="whitespace-pre-wrap">{m.body}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {status.status !== 'REDEEMED' && status.status !== 'REJECTED' && (
                  <div className="space-y-2">
                    <textarea
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      rows={2}
                      maxLength={2000}
                      placeholder="Reply to support…"
                      className="w-full px-3 py-2.5 rounded-lg bg-layer-elevated border border-white/10 outline-none t-label-md"
                    />
                    <button
                      disabled={sendReply.isPending || reply.trim().length === 0}
                      onClick={() => sendReply.mutate()}
                      className="h-10 px-4 rounded-xl border border-white/15 bg-white/5 t-label-md text-white/80 hover:bg-white/10 disabled:opacity-40"
                    >
                      Send message
                    </button>
                  </div>
                )}
              </>
            )}

            {trimmedTicket.length >= 8 && !status && !isFetching && (
              <p className="t-label-sm text-muted">
                No request matches that code. Check it, or file a new request.
              </p>
            )}
            {isFetching && !status && <p className="t-label-sm text-muted">Checking…</p>}
          </div>
        )}

        <div className="text-center mt-6">
          <p className="t-label-md text-secondary">
            Remembered your password?{' '}
            <Link href="/login" className="text-gold underline underline-offset-2 decoration-gold/70">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
