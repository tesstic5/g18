// apps/web/src/components/BetBar.tsx — persistent, INLINE bet controls.
//
// WHY THIS REPLACES THE MODAL
// ---------------------------
// The old BetPanel opened a full-screen modal over the board. Because it also
// exposed an `extraControls` slot, most games put their actual game decisions
// (dice target, plinko risk, which thimble cup, lucky-number zone) inside that
// modal. The result was a flow where the player never touched the game:
//
//     tap PLAY -> popup covers the board -> choose inside the popup ->
//     tap action -> popup closes -> watch an animation -> result
//
// The board became a television. This component is always visible beneath the
// board and never covers it, so the player makes their choice ON the game and
// only sets the stake here.
//
// It intentionally has NO `extraControls` slot — game decisions belong on the
// board. The only thing a game may pass is `requirement`, a short sentence
// explaining what is still needed before the button becomes active
// (e.g. "Tap a segment to back it"), so the CTA is never a dead button.
'use client';
import React, { useEffect, useState } from 'react';
import { vibrate } from '../hooks';
import { BetConfirmSheet } from './BetConfirmSheet';

export interface BetBarProps {
  minBet: number;
  balance: number;
  onBet: (amount: number) => unknown;
  /** Verb for the primary action: "ROLL", "SPIN", "FLIP"… */
  actionLabel: string;
  isLoading?: boolean;
  /**
   * When set, the action is blocked and this sentence is shown INSTEAD of the
   * label — it must say what the player has to do, never just grey out.
   */
  requirement?: string | null;
  /** Live payout preview, e.g. 1.98 -> "Win ₨19.80" */
  multiplier?: number | null;
  /** Extra chips/toggles that belong to STAKING (not game choices) — rare. */
  children?: React.ReactNode;
  /** Upper stake limit (admin `global_max_bet`, or the game's own if lower). */
  maxBet?: number;
  /** Plain-English summary of the board pick, shown in the confirm sheet. */
  selection?: string | null;
  /**
   * Independent copies of this stake (Plinko balls). The confirm sheet and
   * insufficient-balance check use amount × count.
   */
  units?: { count: number; label: string } | null;
  /**
   * A live round the player can end early (Mines/Tower/Stairs/Hi-Lo, crash).
   * Rendered as a CASH OUT button directly BESIDE the main action, which is
   * where players look for it — it used to replace the whole bet panel.
   */
  cashout?: { label: string; onCashout: () => void; busy?: boolean } | null;
}

const CURRENCY = () => process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨';
const QUICK = [10, 50, 200, 1000];

export function BetBar({
  minBet,
  balance,
  onBet,
  actionLabel,
  isLoading,
  requirement,
  multiplier,
  children,
  maxBet,
  selection,
  cashout,
  units,
}: BetBarProps) {
  const [amount, setAmount] = useState(Math.max(1, minBet));
  // Tapping the main action opens a confirm sheet (stake + terms) rather than
  // firing money straight out of the wallet.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setAmount((a) => Math.max(a, minBet));
  }, [minBet]);

  const unitCount = Math.max(1, units?.count ?? 1);
  const total = +(amount * unitCount).toFixed(2);
  const perUnitCap =
    maxBet && maxBet > 0
      ? Math.max(minBet, +(maxBet / unitCount).toFixed(2))
      : 99_999_999;
  const clamp = (v: number) => Math.max(minBet, +Math.min(v, perUnitCap).toFixed(2));
  const insufficient = total > balance;
  const blocked = Boolean(requirement) || insufficient || isLoading;

  const commitDraft = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0) setAmount(clamp(n));
    setEditing(false);
    setDraft('');
  };

  const play = () => {
    if (blocked) return;
    vibrate(10);
    setConfirmOpen(true);
  };

  /** Commit from inside the sheet, then close it so the board is visible. */
  const commit = async (value: number) => {
    setConfirmOpen(false);
    await onBet(value);
  };

  const win = multiplier != null && multiplier > 0 ? amount * multiplier : null;

  return (
    <div className="space-y-2.5">
      {/* stake row */}
      <div className="flex items-center gap-2">
        <button
          aria-label="Halve bet"
          onClick={() => setAmount(clamp(amount / 2))}
          className="h-11 px-3 rounded-lg bg-layer-elevated border border-white/10 t-label-md text-white/70 active:scale-95 shrink-0"
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
            className="flex-1 min-w-0 h-11 rounded-lg bg-layer-elevated border border-gold/40 text-center t-num-lg text-white outline-none"
          />
        ) : (
          <button
            onClick={() => {
              setEditing(true);
              setDraft(String(amount));
            }}
            className="flex-1 min-w-0 h-11 rounded-lg bg-layer-elevated border border-white/10 flex items-center justify-center gap-1.5"
          >
            <span className="t-label-sm text-muted">Bet</span>
            <span
              className={`t-num-lg tabular-nums ${insufficient ? 'text-red' : 'text-white'}`}
            >
              {CURRENCY()}
              {amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          </button>
        )}

        <button
          aria-label="Double bet"
          onClick={() => setAmount(clamp(amount * 2))}
          className="h-11 px-3 rounded-lg bg-layer-elevated border border-white/10 t-label-md text-white/70 active:scale-95 shrink-0"
        >
          2×
        </button>
      </div>

      {/* quick chips */}
      <div className="grid grid-cols-5 gap-1.5">
        {QUICK.map((a) => (
          <button
            key={a}
            onClick={() => setAmount(clamp(a))}
            className={`h-9 rounded-lg t-num-md transition-all ${amount === a ? 'bg-gold/15 border border-gold/40 text-gold' : 'bg-layer-elevated border border-white/8 text-white/60 active:scale-95'}`}
          >
            {a >= 1000 ? `${a / 1000}K` : a}
          </button>
        ))}
        <button
          onClick={() => setAmount(clamp(balance / unitCount))}
          className={`h-9 rounded-lg t-label-md transition-all ${amount === balance && balance > 0 ? 'bg-gold/15 border border-gold/40 text-gold' : 'bg-layer-elevated border border-white/8 text-white/60 active:scale-95'}`}
        >
          Max
        </button>
      </div>

      {children}

      {/* balance + payout preview */}
      <div className="flex items-center justify-between px-0.5">
        <span className="t-label-sm text-muted">
          Balance{' '}
          <span className="text-gold">
            {CURRENCY()}
            {balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
        </span>
        {win != null && !blocked && (
          <span className="t-label-sm text-muted">
            Win{' '}
            <span className="text-green">
              {CURRENCY()}
              {win.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          </span>
        )}
      </div>

      {/* primary action — always says WHY it is blocked.
          When a round is live, CASH OUT sits right next to it: that is where
          players look for it, and it used to replace the whole panel so the
          bet controls vanished mid-round. */}
      <div className="flex items-stretch gap-2">
        <button
          disabled={blocked}
          onClick={play}
          className={`flex-1 min-w-0 h-14 rounded-xl t-label-lg font-black tracking-wide transition-all ${
            insufficient
              ? 'btn-danger'
              : requirement
                ? 'bg-layer-elevated border border-white/10 text-white/45'
                : 'btn-primary active:scale-[0.98] shadow-[0_4px_20px_rgba(0,217,126,0.35)]'
          }`}
        >
          {isLoading ? (
            <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : insufficient ? (
            'INSUFFICIENT BALANCE'
          ) : requirement ? (
            requirement
          ) : (
            actionLabel
          )}
        </button>

        {cashout && (
          <button
            onClick={cashout.onCashout}
            disabled={cashout.busy}
            className="shrink-0 h-14 px-5 rounded-xl t-label-lg font-black tracking-wide bg-gradient-to-b from-[#ffd75e] to-[#f5a623] text-black shadow-[0_4px_20px_rgba(245,166,35,0.45)] active:scale-[0.98] disabled:opacity-50 animate-cashout-pulse"
          >
            {cashout.busy ? '…' : cashout.label}
          </button>
        )}
      </div>

      <BetConfirmSheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={commit}
        amount={amount}
        setAmount={setAmount}
        minBet={minBet}
        maxBet={maxBet}
        balance={balance}
        actionLabel={actionLabel}
        selection={selection}
        multiplier={multiplier}
        busy={isLoading}
        units={units}
      />

      <style>{`
        @keyframes cashoutPulse { 0%,100% { box-shadow: 0 4px 20px rgba(245,166,35,0.45) } 50% { box-shadow: 0 4px 30px rgba(245,166,35,0.8) } }
        .animate-cashout-pulse { animation: cashoutPulse 1.5s ease-in-out infinite }
      `}</style>
    </div>
  );
}
