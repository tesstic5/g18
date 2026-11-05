// apps/web/src/components/games/board-kit.tsx — shared ON-BOARD betting controls.
//
// These exist so a game's decision lives on the game itself rather than inside a
// modal. Every one of them is a big, obvious, finger-sized target that shows a
// clear selected state, because on a phone the player is choosing with a thumb
// while looking at the board.
'use client';
import React from 'react';
import { GOLD, GREEN } from './game-kit';

/**
 * A row of mutually-exclusive bets rendered as cards ON the board.
 * Each option shows its own payout, so the risk/reward tradeoff is visible at
 * the moment of choosing instead of buried in a rules modal.
 */
export function PickRow<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  columns,
}: {
  options: ReadonlyArray<{
    value: T;
    label: string;
    sub?: string;
    color?: string;
    icon?: string;
  }>;
  value: T | null | undefined;
  onChange: (v: T) => void;
  disabled?: boolean;
  columns?: number;
}) {
  const cols = columns ?? Math.min(options.length, 3);
  return (
    <div
      className="grid gap-2 w-full"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      role="radiogroup"
      aria-label="Bet choice"
    >
      {options.map((o) => {
        const active = value === o.value;
        const accent = o.color ?? GOLD;
        return (
          <button
            key={String(o.value)}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            role="radio"
            aria-checked={active}
            aria-label={o.sub ? `${o.label} — ${o.sub}` : o.label}
            className={`relative rounded-xl border-2 px-2 py-2.5 flex flex-col items-center justify-center gap-0.5 transition-all active:scale-95 disabled:opacity-40 ${
              active ? 'scale-[1.03]' : 'border-white/10 bg-white/[0.04]'
            }`}
            style={
              active
                ? {
                    borderColor: accent,
                    background: `${accent}1f`,
                    boxShadow: `0 0 18px ${accent}55`,
                  }
                : undefined
            }
          >
            {o.icon && <span className="text-xl leading-none">{o.icon}</span>}
            <span
              className={`t-label-md font-bold leading-tight ${active ? '' : 'text-white/75'}`}
              style={active ? { color: accent } : undefined}
            >
              {o.label}
            </span>
            {o.sub && (
              <span className="t-label-sm text-white/45 leading-none">{o.sub}</span>
            )}
            {active && (
              <span
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-black text-black"
                style={{ background: accent }}
              >
                ✓
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A labelled slider that lives on the board (dice target, limbo target…).
 * Shows the live value and the payout it implies.
 */
export function BoardSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  hint,
  accent,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  hint?: string;
  accent?: string;
}) {
  const c = accent ?? GOLD;
  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between mb-1">
        <span className="t-label-sm text-white/60">{label}</span>
        <span className="t-num-md font-bold" style={{ color: c }}>
          {hint}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={hint ?? String(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-6 disabled:opacity-40"
        style={{ accentColor: c }}
      />
    </div>
  );
}

/** A short instruction shown on the board when no choice has been made yet. */
export function PickPrompt({
  children,
  show,
}: {
  children: React.ReactNode;
  show: boolean;
}) {
  if (!show) return null;
  return (
    <div
      role="status"
      className="px-3 py-1.5 rounded-full border border-gold/30 bg-gold/10 animate-pulse-slow"
    >
      <span className="t-label-md text-gold font-semibold">{children}</span>
    </div>
  );
}

/** Confirmation chip showing what the player has staked on, once chosen. */
export function PickedChip({ label, color }: { label: string; color?: string }) {
  const c = color ?? GREEN;
  return (
    <div
      className="px-3 py-1 rounded-full border"
      style={{ borderColor: `${c}66`, background: `${c}18` }}
    >
      <span className="t-label-md font-bold" style={{ color: c }}>
        {label}
      </span>
    </div>
  );
}
