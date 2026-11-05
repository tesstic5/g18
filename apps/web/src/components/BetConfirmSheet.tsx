// apps/web/src/components/BetConfirmSheet.tsx
//
// The confirm step between "I want to bet" and money actually leaving the
// wallet.
//
// IMPORTANT — this is NOT the old bet modal that was removed earlier.
// The old one covered the board AND held the GAME decisions (dice target,
// which cup, plinko risk), so the player never touched the game itself. This
// sheet holds only STAKE decisions and shows a read-only summary of the pick
// the player already made on the board. The board stays visible above it.
//
// It exists because a real-money bet should have one deliberate confirmation:
//   - see the exact stake and what it pays if it wins
//   - adjust the amount without hunting for a different control
//   - agree to the terms (pre-ticked, so repeat play is not punished)
//   - one clear button that commits
//
// It closes the instant the bet is accepted, so the player is watching the
// board — not a dialog — when the round plays out.
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { vibrate } from '../hooks';

const CURRENCY = () => process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨';
const money = (n: number) =>
  `${CURRENCY()}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export interface BetConfirmSheetProps {
  open: boolean;
  onClose: () => void;
  /** Commit the bet. Resolve/throw — the sheet closes either way on success. */
  onConfirm: (amount: number) => Promise<unknown> | unknown;
  amount: number;
  setAmount: (n: number) => void;
  minBet: number;
  maxBet?: number;
  balance: number;
  /** e.g. "ROLL OVER 50.50" — what the player is about to do */
  actionLabel: string;
  /** A plain-English summary of the pick made on the board. */
  selection?: string | null;
  /** Payout multiplier if this bet wins. */
  multiplier?: number | null;
  busy?: boolean;
  /** Independent copies of this stake (Plinko balls). Charge = amount × count. */
  units?: { count: number; label: string } | null;
}

const QUICK = [10, 50, 200, 1000];

export function BetConfirmSheet({
  open,
  onClose,
  onConfirm,
  amount,
  setAmount,
  minBet,
  maxBet,
  balance,
  actionLabel,
  selection,
  multiplier,
  busy,
  units,
}: BetConfirmSheetProps) {
  // Pre-ticked on purpose. The player agreed at signup; making them re-tick a
  // box before every single spin is friction on the one action the whole
  // product depends on. It is still an explicit, visible, un-tickable consent
  // that must be true for the button to work.
  const [agreed, setAgreed] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setAgreed(true);
      setEditing(false);
    }
  }, [open]);

  // Focus trap, Escape close, focus restoration, and scroll lock.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])')
        ?.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const items = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
        ),
      ];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = oldOverflow;
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const unitCount = Math.max(1, units?.count ?? 1);
  const total = +(amount * unitCount).toFixed(2);
  const ceiling = maxBet && maxBet > 0 ? maxBet : 99_999_999;
  const perUnitCap = +(ceiling / unitCount).toFixed(2);
  const clamp = (v: number) =>
    Math.min(perUnitCap, Math.max(minBet, +Number(v || 0).toFixed(2)));
  const tooLow = amount < minBet;
  const tooHigh = total > ceiling;
  const insufficient = total > balance;
  const blocked = !agreed || insufficient || tooLow || tooHigh || !!busy;
  const win = multiplier && multiplier > 0 ? amount * multiplier : null;

  const commitDraft = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0) setAmount(clamp(n));
    setEditing(false);
    setDraft('');
  };

  const confirm = async () => {
    if (blocked) return;
    vibrate(12);
    await onConfirm(amount);
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Confirm your bet"
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md bg-layer-surface border-t sm:border border-white/10 rounded-t-2xl sm:rounded-2xl px-4 pt-3 pb-4 space-y-3 animate-sheet-up sm:mb-6 max-h-[88dvh] overflow-y-auto"
      >
        {/* grab handle */}
        <div className="mx-auto w-10 h-1 rounded-full bg-white/20" />

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="t-label-lg text-primary leading-tight">Confirm your bet</p>
            {selection && (
              <p className="t-label-sm text-gold mt-0.5 truncate">{selection}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Cancel"
            className="shrink-0 w-8 h-8 rounded-full bg-white/5 text-white/60 text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* stake */}
        <div className="flex items-center gap-2">
          <button
            aria-label="Halve bet"
            onClick={() => setAmount(clamp(amount / 2))}
            className="h-12 px-3 rounded-lg bg-layer-elevated border border-white/10 t-label-md text-white/70 active:scale-95 shrink-0"
          >
            ½
          </button>
          {editing ? (
            <input
              autoFocus
              type="number"
              inputMode="decimal"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitDraft();
                if (e.key === 'Escape') {
                  setEditing(false);
                  setDraft('');
                }
              }}
              className="flex-1 min-w-0 h-12 rounded-lg bg-layer-elevated border border-gold/40 text-center t-num-lg text-white outline-none"
            />
          ) : (
            <button
              onClick={() => {
                setEditing(true);
                setDraft(String(amount));
              }}
              className="flex-1 min-w-0 h-12 rounded-lg bg-layer-elevated border border-white/10 flex items-center justify-center gap-1.5"
            >
              <span className="t-label-sm text-muted">Bet</span>
              <span
                className={`t-num-lg tabular-nums ${insufficient || tooLow || tooHigh ? 'text-red' : 'text-white'}`}
              >
                {money(amount)}
              </span>
            </button>
          )}
          <button
            aria-label="Double bet"
            onClick={() => setAmount(clamp(amount * 2))}
            className="h-12 px-3 rounded-lg bg-layer-elevated border border-white/10 t-label-md text-white/70 active:scale-95 shrink-0"
          >
            2×
          </button>
        </div>

        <div className="grid grid-cols-5 gap-1.5">
          {QUICK.map((a) => (
            <button
              key={a}
              onClick={() => setAmount(clamp(a))}
              className={`h-10 rounded-lg t-num-md transition-all ${amount === a ? 'bg-gold/15 border border-gold/40 text-gold' : 'bg-layer-elevated border border-white/8 text-white/60 active:scale-95'}`}
            >
              {a >= 1000 ? `${a / 1000}K` : a}
            </button>
          ))}
          <button
            onClick={() => setAmount(clamp(balance / unitCount))}
            className="h-10 rounded-lg t-label-md bg-layer-elevated border border-white/8 text-white/60 active:scale-95"
          >
            Max
          </button>
        </div>

        {/* what happens if it wins */}
        <div className="rounded-xl bg-layer-elevated border border-white/8 px-3 py-2.5 space-y-1">
          <div className="flex items-center justify-between">
            <span className="t-label-sm text-muted">Balance</span>
            <span className="t-num-md text-gold">{money(balance)}</span>
          </div>
          {unitCount > 1 && (
            <div className="flex items-center justify-between">
              <span className="t-label-sm text-muted">
                {unitCount} {units?.label ?? 'units'} × {money(amount)}
              </span>
              <span className="t-num-md text-gold">{money(total)} total</span>
            </div>
          )}
          {win != null && (
            <div className="flex items-center justify-between">
              <span className="t-label-sm text-muted">If this wins</span>
              <span className="t-num-md text-green">
                {money(win)}{' '}
                <span className="text-white/40">({multiplier!.toFixed(2)}×)</span>
              </span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="t-label-sm text-muted">Min / Max</span>
            <span className="t-num-sm text-white/50">
              {money(minBet)} – {money(ceiling)}
            </span>
          </div>
        </div>

        {/* terms — pre-ticked, still explicit */}
        <label className="flex items-start gap-2.5 px-0.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 w-5 h-5 shrink-0 accent-[#00d97e]"
          />
          <span className="t-label-sm text-white/60 leading-snug">
            I agree to the{' '}
            <a
              href="/legal/terms"
              target="_blank"
              rel="noreferrer"
              className="text-gold underline"
            >
              Terms
            </a>{' '}
            and confirm I am betting real money. Outcomes are final.
          </span>
        </label>

        <button
          disabled={blocked}
          onClick={() => void confirm()}
          className={`w-full h-14 rounded-xl t-label-lg font-black tracking-wide transition-all ${
            insufficient || tooLow || tooHigh
              ? 'btn-danger'
              : blocked
                ? 'bg-layer-elevated border border-white/10 text-white/45'
                : 'btn-primary active:scale-[0.98] shadow-[0_4px_20px_rgba(0,217,126,0.35)]'
          }`}
        >
          {busy ? (
            <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : insufficient ? (
            'INSUFFICIENT BALANCE'
          ) : tooLow ? (
            `MINIMUM BET IS ${money(minBet)}`
          ) : tooHigh ? (
            `MAXIMUM BET IS ${money(ceiling)}`
          ) : !agreed ? (
            'TICK THE BOX TO CONTINUE'
          ) : (
            `${actionLabel} · ${money(amount)}`
          )}
        </button>

        <style>{`
          @keyframes sheetUp { from { transform: translateY(18px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
          .animate-sheet-up { animation: sheetUp .18s cubic-bezier(.2,.9,.3,1) both }
        `}</style>
      </div>
    </div>
  );
}
