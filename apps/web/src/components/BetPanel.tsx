// apps/web/src/components/BetPanel.tsx — shared bet controls (D-064: PLAY-button modal).
// The bottom bar is compact (balance + amount + PLAY). Tapping PLAY opens a
// responsive modal with amount chips (10/50/200/1000/Max) and game-specific
// controls.
//
// Auto-play / multi-bet was REMOVED by product decision: every bet must be an
// explicit user action.
'use client';
import React, { useEffect, useState } from 'react';
import { vibrate } from '../hooks';

interface BetPanelProps {
  minBet: number;
  balance: number;
  onBet: (amount: number) => unknown;
  actionLabel: string; // "ROLL DICE" | "SPIN" | "DROP BALL"
  potentialWin?: number;
  isLoading?: boolean;
  isDisabled?: boolean;
  extraControls?: React.ReactNode; // game-specific controls (shown inside modal)
}

const QUICK_AMOUNTS = [10, 50, 200, 1000];

export function BetPanel({
  minBet,
  balance,
  onBet,
  actionLabel,
  potentialWin,
  isLoading,
  isDisabled,
  extraControls,
}: BetPanelProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(minBet);
  const [keypadOpen, setKeypadOpen] = useState(false);
  const insufficient = amount > balance;

  // close modal when a bet starts resolving (avoid closing mid-animation state)
  useEffect(() => {
    if (isLoading) setOpen(false);
  }, [isLoading]);

  const setAmountSafe = (v: number) =>
    setAmount(Math.max(minBet, +Math.min(v, 99999999).toFixed(2)));
  const quick = (fn: (a: number) => number) => setAmountSafe(fn(amount));

  const placeBet = () => {
    if (insufficient || isDisabled || isLoading) return;
    vibrate(10);
    // D-090: close the popup the INSTANT the user taps the action button —
    // never wait for the server round-trip (previously the modal stayed open
    // until the bet response arrived, which felt broken on slow networks).
    setOpen(false);
    onBet(amount);
  };

  return (
    <>
      {/* ── COMPACT BOTTOM BAR ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0 rounded-xl bg-layer-elevated border border-white/10 px-3 h-14 flex items-center justify-between">
          <div className="min-w-0">
            <p className="t-label-sm text-muted">Bet</p>
            <p className="t-num-lg text-white tabular-nums leading-tight truncate">
              {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
              {amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="t-label-sm text-muted">Balance</p>
            <p className="t-num-md text-gold leading-tight">
              {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
              {balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        <button
          aria-label="Open bet panel"
          // D-096: isDisabled must NOT block opening the modal — games like
          // Keno disable the CTA until you pick numbers, but the modal (with
          // the explanation) must still open.
          disabled={isLoading}
          onClick={() => setOpen(true)}
          className="btn-primary h-14 px-8 rounded-xl shadow-[0_4px_20px_rgba(0,217,126,0.35)] disabled:opacity-40"
        >
          {isLoading ? '…' : 'Play'}
        </button>
      </div>

      {/* ── BET MODAL ──────────────────────────────────────────────────── */}
      {open && (
        <div
          className="fixed inset-0 z-[125] bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full sm:max-w-md max-h-[90dvh] overflow-y-auto bg-layer-surface rounded-t-2xl sm:rounded-2xl border border-white/10 shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* header */}
            <div className="sticky top-0 bg-layer-surface z-10 px-5 pt-4 pb-3 border-b border-white/8 flex items-center justify-between">
              <div>
                <h2 className="t-label-xl text-primary">Place Bet</h2>
                <p className="t-label-sm text-muted">
                  Balance {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
                  {balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </p>
              </div>
              <button
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="w-9 h-9 rounded-full bg-white/5 text-white/60 active:scale-90"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-5">
              {/* AMOUNT CHIPS 10/50/200/1000/Max */}
              <div>
                <p className="t-label-md text-secondary mb-2">Amount</p>
                <div className="grid grid-cols-5 gap-2">
                  {QUICK_AMOUNTS.map((a) => (
                    <button
                      key={a}
                      onClick={() => setAmountSafe(a)}
                      className={`h-11 rounded-lg t-num-lg transition-all ${amount === a ? 'bg-gold/15 border border-gold/40 text-gold' : 'bg-layer-elevated border border-white/8 text-white/70 active:scale-95'}`}
                    >
                      {a >= 1000 ? '1K' : a}
                    </button>
                  ))}
                  <button
                    onClick={() => setAmountSafe(balance)}
                    className={`h-11 rounded-lg t-label-md transition-all ${amount === balance ? 'bg-gold/15 border border-gold/40 text-gold' : 'bg-layer-elevated border border-white/8 text-white/70 active:scale-95'}`}
                  >
                    Max
                  </button>
                </div>

                {/* custom amount row */}
                <div className="flex items-center gap-2 mt-2">
                  <button
                    onClick={() => quick((a) => a - (a > 100 ? 100 : minBet))}
                    className="w-11 h-11 rounded-lg bg-layer-elevated border border-white/10 text-white/70 active:scale-95"
                  >
                    −
                  </button>
                  <button
                    onClick={() => setKeypadOpen(true)}
                    className="flex-1 h-11 rounded-lg bg-layer-elevated border border-white/10"
                  >
                    <span
                      className={`t-num-xl tabular-nums ${insufficient ? 'text-red' : 'text-white'}`}
                    >
                      {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
                      {amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  </button>
                  <button
                    onClick={() => quick((a) => a + 100)}
                    className="w-11 h-11 rounded-lg bg-layer-elevated border border-white/10 text-white/70 active:scale-95"
                  >
                    +
                  </button>
                </div>
                {insufficient && (
                  <p className="t-label-sm text-red mt-1">
                    Exceeds balance by {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
                    {(amount - balance).toFixed(2)}
                  </p>
                )}
              </div>

              {/* GAME-SPECIFIC CONTROLS (dice target, mines, risk, etc.) */}
              {extraControls && (
                <div>
                  <p className="t-label-md text-secondary mb-2">Options</p>
                  {extraControls}
                </div>
              )}

              {/* POTENTIAL WIN */}
              {potentialWin !== undefined && (
                <div className="flex justify-between items-center rounded-xl bg-layer-elevated border border-white/8 px-4 py-3">
                  <span className="t-label-md text-secondary">Potential Win</span>
                  <span className="t-num-lg text-green">
                    {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
                    {potentialWin.toFixed(2)}
                  </span>
                </div>
              )}

              {/* PLACE BET */}
              <button
                disabled={insufficient || isDisabled || isLoading}
                onClick={placeBet}
                className={`w-full ${insufficient ? 'btn-danger' : 'btn-primary'} h-[54px] rounded-xl`}
              >
                {isLoading ? (
                  <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : insufficient ? (
                  'INSUFFICIENT BALANCE'
                ) : (
                  actionLabel
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CUSTOM NUMERIC KEYPAD (bottom sheet) */}
      {keypadOpen && (
        <div
          className="fixed inset-0 z-[130] bg-black/70 flex items-end"
          onClick={() => setKeypadOpen(false)}
        >
          <div
            className="w-full bg-layer-elevated rounded-t-2xl border-t border-white/10 p-4 pb-[max(16px,env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-9 h-1 bg-white/15 rounded-full mx-auto mb-4" />
            <p className="t-num-xl text-white text-center mb-2">
              {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
              {amount.toFixed(2)}
            </p>
            <div className="grid grid-cols-3 gap-2">
              {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'].map((k) => (
                <button
                  key={k}
                  className="h-[52px] t-num-lg text-white active:bg-white/10 active:scale-95 rounded-lg"
                  onClick={() => setAmount((a) => editAmount(a, k))}
                >
                  {k}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <button
                className="h-12 rounded-lg bg-white/5 t-label-lg text-white/70"
                onClick={() => setKeypadOpen(false)}
              >
                CANCEL
              </button>
              <button
                className="btn-primary h-12 rounded-lg"
                onClick={() => setKeypadOpen(false)}
              >
                CONFIRM
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function editAmount(current: number, key: string): number {
  const str = current.toFixed(2).replace('.', '');
  const next = key === '⌫' ? str.slice(0, -1) : str === '0' ? key : str + key;
  const n = Number(next.slice(0, -2) + '.' + next.slice(-2));
  return isNaN(n) ? current : Math.min(n, 99999999);
}
