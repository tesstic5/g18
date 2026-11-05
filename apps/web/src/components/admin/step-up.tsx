// apps/web/src/components/admin/step-up.tsx — STEP-UP RE-AUTHENTICATION.
//
// Panel actions that move money (approve a payout, adjust a balance, restore a
// backup, rotate the encryption key, release a freeze) now require the admin to
// have proved their password within the last `admin_step_up_minutes`.
//
// The API refuses with 403 / code AUTH_010 rather than prompting, because the
// browser is the right place to ask. `useStepUp()` wraps a request so the flow
// is one line at the call site:
//
//   const stepUp = useStepUp();
//   const review = useMutation({
//     mutationFn: (args) => stepUp.run(() => http.patch(`/panel/withdrawals/${args.id}`, ...)),
//   });
//
// On AUTH_010 it opens a password modal, re-authenticates, and REPLAYS the
// original request — so the operator sees one action, not two.
//
// The pending request is held in state, not in a ref, and resolved by the
// modal's handlers ONLY. Writing a ref during render (the obvious first
// implementation) is what React calls a "ref access during render": it makes
// the component's output depend on a mutable value the renderer may run twice,
// and it hides the pending request from React's own bookkeeping.
'use client';
import React, { useCallback, useRef, useState } from 'react';
import { http, ApiError } from '../../lib/api';
import { notify } from '../../lib/toast';
import { ActionBtn, Icon, TextInput } from './ui';

const STEP_UP_CODE = 'AUTH_010';

export function isStepUpRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === STEP_UP_CODE;
}

/** The blocked request plus the promise handles that will settle it. */
interface PendingAction {
  replay: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export function useStepUp() {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref is the right tool for "cancel the LATEST promise" (stale-closure
  // safety), and it is only ever touched inside handlers — never during render.
  const latest = useRef<PendingAction | null>(null);

  /** Run `fn`; if the server asks for a fresh password, ask, then replay it. */
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!isStepUpRequired(e)) throw e;
      return new Promise<T>((resolve, reject) => {
        const action: PendingAction = {
          replay: fn as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        };
        latest.current = action;
        setError(null);
        setPassword('');
        setPending(action);
      });
    }
  }, []);

  const cancel = useCallback(() => {
    const action = latest.current;
    latest.current = null;
    setPending(null);
    setPassword('');
    setError(null);
    action?.reject(new ApiError(STEP_UP_CODE, 403, 'Cancelled'));
  }, []);

  const confirm = useCallback(async () => {
    const action = latest.current;
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      await http.post('/panel/auth/reauth', { password });
      latest.current = null;
      setPending(null);
      setPassword('');
      action.resolve(await action.replay());
    } catch (e) {
      const err = e as ApiError;
      if (err instanceof ApiError && err.code === 'AUTH_001') setError('Incorrect password');
      else setError(err.message || 'Re-authentication failed');
    } finally {
      setBusy(false);
    }
  }, [password]);

  const modal = pending ? (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={cancel} />
      <div className="relative w-full max-w-sm rounded-2xl bg-layer-surface border border-white/10 shadow-2xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <span className="h-8 w-8 rounded-lg bg-gold/15 text-gold flex items-center justify-center">
            <Icon name="shield" size={16} />
          </span>
          <h2 className="t-label-xl text-primary">Confirm your password</h2>
        </div>
        <p className="t-label-sm text-secondary">
          This action moves money or changes security settings. Re-enter your panel password to
          continue.
        </p>
        <TextInput
          type="password"
          value={password}
          autoFocus
          placeholder="Your password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && password) void confirm();
            if (e.key === 'Escape') cancel();
          }}
        />
        {error && (
          <p className="t-label-sm text-red bg-red/10 border border-red/25 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <ActionBtn onClick={cancel} disabled={busy}>
            Cancel
          </ActionBtn>
          <ActionBtn tone="gold" onClick={() => void confirm()} disabled={busy || !password}>
            {busy ? 'Checking…' : 'Confirm'}
          </ActionBtn>
        </div>
      </div>
    </div>
  ) : null;

  return { run, modal, required: Boolean(pending) };
}

/** Silent step-up attempt for background flows (no modal): tells the operator to expect a prompt. */
export async function ensureStepUp(reason: string): Promise<boolean> {
  try {
    await http.post('/panel/auth/reauth', {});
    return true;
  } catch {
    notify.error(`${reason} — confirm your password first (any money action will prompt you).`);
    return false;
  }
}
