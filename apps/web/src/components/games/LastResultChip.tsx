// apps/web/src/components/games/LastResultChip.tsx
//
// THE PROBLEM THIS SOLVES
// -----------------------
// A round used to end like this:
//
//   1. the board animates
//   2. a big "YOU WIN!" banner flashes for 2.6 seconds
//   3. the banner disappears
//   4. ...and the board keeps showing the OLD round's result for ever
//
// So a player who looked away for three seconds had no idea what had just
// happened, and the board never visibly said "I am ready for another go".
// There was also no way to repeat the same bet without re-entering the stake.
//
// This chip lives in the top-right corner of the board (absolutely positioned,
// so it costs the layout no vertical space) and answers three questions that
// were previously unanswerable:
//
//   * what happened last round, and how much did it pay?   -> the chip text
//   * is the game ready for me again?                      -> "Ready" dot
//   * can I just do that again?                            -> Repeat button
'use client';
import React from 'react';
import type { RoundResult } from './types';

const CURRENCY = () => process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨';

export interface LastRound {
  result: RoundResult;
  /** payout multiplier, when the game reported one */
  multiplier?: number;
  /** money returned to the wallet (0 on a total loss) */
  payout?: number;
  /** what was staked, so we can show the true profit and offer a repeat */
  stake?: number;
}

const money = (n: number) =>
  `${CURRENCY()}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function LastResultChip({
  last,
  busy,
  onRepeat,
}: {
  last: LastRound | null;
  /** a round is in flight — show the live state instead of the memory */
  busy?: boolean;
  /** re-place the previous stake with the choices still on the board */
  onRepeat?: (() => void) | null;
}) {
  if (busy) {
    return (
      <div className="absolute top-2 right-2 z-20 pointer-events-none flex items-center gap-1.5 rounded-full bg-black/55 border border-gold/25 px-2.5 py-1 backdrop-blur-sm">
        <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
        <span className="t-label-sm text-gold/90 tracking-wide">ROUND IN PLAY</span>
      </div>
    );
  }

  if (!last) {
    return (
      <div className="absolute top-2 right-2 z-20 pointer-events-none flex items-center gap-1.5 rounded-full bg-black/40 border border-white/10 px-2.5 py-1 backdrop-blur-sm">
        <span className="w-1.5 h-1.5 rounded-full bg-white/40" />
        <span className="t-label-sm text-white/50 tracking-wide">READY</span>
      </div>
    );
  }

  const stake = Number(last.stake ?? 0);
  const payout = Number(last.payout ?? 0);
  // The honest number is the CHANGE to the wallet, not the payout. A 0.4x
  // bucket pays money back but is still a loss, and showing "+₨40" there is
  // how players end up thinking the balance is broken.
  const net = payout - stake;
  const netLabel =
    net > 0 ? `+${money(net)}` : net < 0 ? `−${money(Math.abs(net))}` : money(0);
  const colour = net > 0 ? '#00d97e' : net < 0 ? '#ff4d6a' : 'rgba(255,255,255,0.65)';

  return (
    <div className="absolute top-2 right-2 z-20 flex items-center gap-1.5">
      <div
        className="flex items-center gap-2 rounded-full bg-black/55 border px-2.5 py-1 backdrop-blur-sm"
        style={{ borderColor: `${colour}44` }}
      >
        <span className="t-label-sm text-white/45 tracking-wide">LAST</span>
        {last.multiplier !== undefined && (
          <span className="t-num-sm tabular-nums text-white/85">
            {last.multiplier.toFixed(2)}×
          </span>
        )}
        <span className="t-num-sm tabular-nums font-bold" style={{ color: colour }}>
          {netLabel}
        </span>
      </div>

      {onRepeat && stake > 0 && (
        <button
          onClick={onRepeat}
          aria-label={`Bet ${money(stake)} again`}
          className="flex items-center gap-1 rounded-full bg-gold/15 border border-gold/40 px-2.5 py-1 active:scale-95 transition-transform"
        >
          <span className="t-label-sm text-gold">↻ {money(stake)}</span>
        </button>
      )}
    </div>
  );
}
