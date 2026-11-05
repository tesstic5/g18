// apps/web/src/components/games/individual/BaccaratGame.tsx — REAL baccarat (D-093):
// sequential dealing (P1→B1→P2→B2→P3/B3 per the standard third-card rules), points
// count up, winner glows, tie pushes. Every card is driven by the server outcome.
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { BetBar } from '../../BetBar';
import { Segment } from '../types';
import { GameBackdrop, ResultBanner, CountUp, GOLD, GREEN } from '../game-kit';
import { useRoundFlow, flowFallbackMs } from '../useRoundFlow';
import { sound } from '../../../lib/sound';
import { vibrate } from '../../../hooks';
import type { GameVisualProps, GameBetPanelProps } from '../types';

const SUITS = ['♠', '♥', '♦', '♣'];
const faces = (v: number) =>
  v === 1
    ? 'A'
    : v >= 10
      ? v === 11
        ? 'J'
        : v === 12
          ? 'Q'
          : v === 13
            ? 'K'
            : '10'
      : String(v);

function BaccaratCard({
  v,
  show,
  size = 'md',
  dim,
}: {
  v: number;
  show: boolean;
  size?: 'md' | 'lg';
  dim?: boolean;
}) {
  const suit = SUITS[(v * 7) % 4]!;
  const color = suit === '♥' || suit === '♦' ? '#e53e3e' : '#1a1a1a';
  const w = size === 'lg' ? 'w-14 sm:w-16' : 'w-11 sm:w-13';
  const h = size === 'lg' ? 'h-20 sm:h-24' : 'h-16 sm:h-20';
  return (
    <div
      className={`${w} ${h} rounded-lg bg-gradient-to-br from-white to-slate-200 shadow-[0_6px_16px_rgba(0,0,0,0.5)] flex items-center justify-center relative border border-black/5 transition-all duration-400 ${show ? 'opacity-100 rotate-0 translate-y-0 scale-100' : 'opacity-0 -translate-y-6 scale-75 rotate-6'} ${dim ? 'opacity-40 grayscale' : ''}`}
      style={{ transformStyle: 'preserve-3d' }}
    >
      <span
        className="absolute top-0.5 left-1.5 text-[10px] font-black"
        style={{ color }}
      >
        {faces(v)}
      </span>
      <span className="text-lg sm:text-xl font-black" style={{ color }}>
        {suit}
      </span>
      <span
        className="absolute bottom-0.5 right-1.5 text-[10px] font-black"
        style={{ color }}
      >
        {faces(v)}
      </span>
    </div>
  );
}

export function BaccaratVisual({
  outcome,
  result,
  choices,
  setChoices,
  onRoundComplete,
}: GameVisualProps) {
  // Hold the result back until the deal has actually finished — completion is
  // the board's explicit call after the points count up, not a guess timer.
  const flow = useRoundFlow(outcome, flowFallbackMs('baccarat'), onRoundComplete);
  // flow.outcome (sticky), not the raw prop — it parks at null between rounds.
  const res = flow.outcome as {
    playerCards?: number[];
    bankerCards?: number[];
    playerDraws?: boolean;
    bankerDraws?: boolean;
    playerPoint?: number;
    bankerPoint?: number;
    outcome?: string;
    win?: boolean;
    isPush?: boolean;
  } | null;
  // Round-tagged display state — checked AT RENDER so a new round's first
  // painted frame never shows the previous round's dealt table.
  const [shownState, setShownState] = useState({ round: 0, value: 0 }); // cards revealed (0..6)
  const [pointsState, setPointsState] = useState({ round: 0, value: false });
  const shown = shownState.round === flow.roundKey ? shownState.value : 0;
  const revealPoints = pointsState.round === flow.roundKey && pointsState.value;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (!res?.playerCards) return;
    const round = flow.roundKey;
    setShownState({ round, value: 0 });
    setPointsState({ round, value: false });
    timers.current.forEach(clearTimeout);
    timers.current = [];
    sound.play('card_deal');
    const seq: Array<[number, 'p' | 'b']> = [
      [0, 'p'],
      [400, 'b'],
      [800, 'p'],
      [1200, 'b'],
      ...(res.playerDraws ? [[1700, 'p'] as [number, 'p' | 'b']] : []),
      ...(res.bankerDraws ? [[2150, 'b'] as [number, 'p' | 'b']] : []),
    ];
    seq.forEach(([t], i) => {
      timers.current.push(
        setTimeout(() => {
          setShownState({ round, value: i + 1 });
          if (i > 0) sound.play('card_deal');
        }, t)
      );
    });
    // Points land a beat after the FINAL card, whenever that card was — the
    // old fixed 2600ms left a dead pause when nobody drew, and squeezed the
    // count-up when both sides did.
    const lastCardAt = seq[seq.length - 1]![0];
    timers.current.push(
      setTimeout(() => setPointsState({ round, value: true }), lastCardAt + 650)
    );
    // Count-up finished → the board declares the round complete.
    timers.current.push(setTimeout(() => flow.complete(), lastCardAt + 650 + 800));
    return () => timers.current.forEach(clearTimeout);
  }, [
    flow.roundKey,
    res?.playerCards?.length,
    res?.playerDraws,
    res?.bankerDraws,
    res?.playerPoint,
  ]);

  const playerCards = res?.playerCards ?? [];
  const bankerCards = res?.bankerCards ?? [];
  const winSide = revealPoints ? res?.outcome : undefined;
  const isPush = revealPoints ? res?.isPush : false;

  return (
    <GameBackdrop accent={GREEN}>
      {/* D-101: scroll-safe wrapper */}
      <div className="relative w-full h-full overflow-y-auto">
        <div
          className="min-h-full w-full flex flex-col items-center justify-center gap-3 px-3 py-2"
          style={{
            background: 'radial-gradient(circle at 50% 40%, #0f3d1f 0%, #08180d 75%)',
          }}
        >
          {/* felt table */}
          <div
            className="w-[min(94vw,500px)] rounded-3xl border-2 border-gold/20 p-4 sm:p-6"
            style={{
              background:
                'radial-gradient(circle, rgba(0,217,126,0.06), transparent 70%)',
              boxShadow: 'inset 0 0 60px rgba(0,0,0,0.5)',
            }}
          >
            <div className="grid grid-cols-2 gap-4 sm:gap-6">
              {/* PLAYER side */}
              <div className="text-center">
                <p
                  className="t-label-lg font-black tracking-widest mb-2"
                  style={{
                    color:
                      winSide === 'player' && !isPush ? GOLD : 'rgba(255,255,255,0.45)',
                    textShadow:
                      winSide === 'player' && !isPush
                        ? `0 0 20px ${GOLD}66`
                        : undefined,
                  }}
                >
                  PLAYER
                </p>
                <div className="flex justify-center gap-1.5 min-h-[68px] items-end">
                  {playerCards.map((c, i) => (
                    <BaccaratCard
                      key={i}
                      v={c}
                      show={shown > i}
                      size="lg"
                      dim={winSide === 'banker' && !isPush}
                    />
                  ))}
                  {playerCards.length === 0 && (
                    <span className="t-label-sm text-white/20 py-6">—</span>
                  )}
                </div>
                <p
                  className={`t-num-xl font-black mt-1.5 ${winSide === 'player' && !isPush ? 'text-green' : 'text-white/70'}`}
                  style={revealPoints ? { transition: 'all .4s' } : { opacity: 0.3 }}
                >
                  {revealPoints ? (
                    <CountUp
                      value={res?.playerPoint ?? 0}
                      decimals={0}
                      duration={700}
                    />
                  ) : (
                    '·'
                  )}
                </p>
                {res?.playerDraws && (
                  <span className="t-label-sm text-white/35 mt-0.5">drew 3rd card</span>
                )}
              </div>
              {/* BANKER side */}
              <div className="text-center">
                <p
                  className="t-label-lg font-black tracking-widest mb-2"
                  style={{
                    color:
                      winSide === 'banker' && !isPush ? GOLD : 'rgba(255,255,255,0.45)',
                    textShadow:
                      winSide === 'banker' && !isPush
                        ? `0 0 20px ${GOLD}66`
                        : undefined,
                  }}
                >
                  BANKER
                </p>
                <div className="flex justify-center gap-1.5 min-h-[68px] items-end">
                  {bankerCards.map((c, i) => (
                    <BaccaratCard
                      key={i}
                      v={c}
                      show={shown > 1 + 2 * i}
                      size="lg"
                      dim={winSide === 'player' && !isPush}
                    />
                  ))}
                  {bankerCards.length === 0 && (
                    <span className="t-label-sm text-white/20 py-6">—</span>
                  )}
                </div>
                <p
                  className={`t-num-xl font-black mt-1.5 ${winSide === 'banker' && !isPush ? 'text-green' : 'text-white/70'}`}
                >
                  {revealPoints ? (
                    <CountUp
                      value={res?.bankerPoint ?? 0}
                      decimals={0}
                      duration={700}
                    />
                  ) : (
                    '·'
                  )}
                </p>
                {res?.bankerDraws && (
                  <span className="t-label-sm text-white/35 mt-0.5">drew 3rd card</span>
                )}
              </div>
            </div>

            {/* result line */}
            <div className="mt-3 pt-2 border-t border-white/10 text-center min-h-[28px]">
              {revealPoints && winSide && (
                <span
                  className={`t-label-lg font-black tracking-widest ${isPush ? 'text-gold' : winSide === 'player' ? 'text-green' : 'text-white/70'} animate-spring-in`}
                >
                  {isPush
                    ? '⚖️ TIE — BET RETURNED'
                    : `${winSide.toUpperCase()} WINS ${res?.playerPoint}–${res?.bankerPoint}`}
                </span>
              )}
            </div>
          </div>

          {/* bet chips */}
          <div className="flex gap-2">
            {(
              [
                ['player', 'PLAYER 1.95×', GREEN],
                ['banker', 'BANKER 1.9×', GOLD],
                ['tie', 'TIE 10.13×', '#9b59ff'],
              ] as const
            ).map(([key, label, color]) => {
              const sel = String(choices.bet ?? '') === key;
              return (
                <button
                  key={key}
                  onClick={() => {
                    setChoices({ ...choices, bet: key });
                    vibrate(8);
                  }}
                  className={`h-11 px-4 rounded-full t-label-md font-black tracking-wide transition-all active:scale-95 border-2 ${sel ? 'scale-105' : 'opacity-70'}`}
                  style={{
                    background: `${color}22`,
                    borderColor: sel ? color : `${color}55`,
                    color: sel ? color : '#fff',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <ResultBanner
            ready={flow.revealed}
            roundKey={flow.roundKey}
            result={result}
            multiplier={(res as { multiplier?: number })?.multiplier}
            payout={
              result === 'WIN' ? (outcome as { payout?: number })?.payout : undefined
            }
            accent={GREEN}
          />
        </div>
      </div>
    </GameBackdrop>
  );
}

export function BaccaratBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  // The three bets are already on the felt where they belong — this panel used
  // to render a SECOND copy of them inside the popup, so the same choice
  // existed in two places and the popup covered the table you were betting on.
  const bet = String(choices.bet ?? '');
  const pay: Record<string, number> = { player: 1.95, banker: 1.9, tie: 10.13 };
  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel={bet ? `DEAL \u2014 ${bet.toUpperCase()}` : 'DEAL'}
      selection={
        bet
          ? `Backing ${bet.toUpperCase()} · pays ${(pay[bet] ?? 0).toFixed(2)}\u00d7`
          : null
      }
      requirement={bet ? null : 'Tap PLAYER, BANKER or TIE on the table'}
      multiplier={pay[bet] ?? null}
    />
  );
}
