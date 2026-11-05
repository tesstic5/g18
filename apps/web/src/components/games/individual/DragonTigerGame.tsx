// apps/web/src/components/games/individual/DragonTigerGame.tsx — REAL dragon-tiger
// (D-093): dragon card slides in, tiger card slides in, the higher rank glows and
// scales, tie pushes. Server outcome drives everything.
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { BetBar } from '../../BetBar';
import { Segment } from '../types';
import { GameBackdrop, ResultBanner, GOLD, GREEN, RED } from '../game-kit';
import { useRoundFlow, flowFallbackMs } from '../useRoundFlow';
import { sound } from '../../../lib/sound';
import { vibrate } from '../../../hooks';
import type { GameVisualProps, GameBetPanelProps } from '../types';

function DTCard({
  rank,
  suit,
  flip,
  winner,
  loser,
  delay = 0,
}: {
  rank: string;
  suit: string;
  flip: boolean;
  winner?: boolean;
  loser?: boolean;
  delay?: number;
}) {
  const color = suit === '♥' || suit === '♦' ? '#e53e3e' : '#1a1a1a';
  return (
    <div
      className={`w-20 h-28 sm:w-24 sm:h-32 rounded-xl bg-gradient-to-br from-white to-slate-200 shadow-[0_10px_28px_rgba(0,0,0,0.55)] flex items-center justify-center relative border border-black/5 transition-all duration-500 ${flip ? 'rotate-0 translate-x-0 translate-y-0 scale-100 opacity-100' : 'opacity-0 translate-y-8 scale-75'}`}
      style={{
        transitionDelay: `${delay}ms`,
        ...(winner
          ? {
              boxShadow: `0 0 40px ${GOLD}99, 0 10px 28px rgba(0,0,0,0.55)`,
              transform: 'scale(1.08)',
            }
          : {}),
        ...(loser ? { opacity: 0.4, filter: 'grayscale(0.7)' } : {}),
      }}
    >
      <span className="absolute top-1.5 left-2 text-lg font-black" style={{ color }}>
        {rank}
      </span>
      <span className="absolute top-8 left-2 text-lg" style={{ color }}>
        {suit}
      </span>
      <span className="text-6xl font-black" style={{ color }}>
        {suit}
      </span>
      <span
        className="absolute bottom-1.5 right-2 text-lg font-black rotate-180"
        style={{ color }}
      >
        {rank}
      </span>
    </div>
  );
}

export function DragonTigerVisual({
  outcome,
  result,
  choices,
  setChoices,
  onRoundComplete,
}: GameVisualProps) {
  // Hold the result back until this game's animation has finished — completion
  // is the board's explicit call after the reveal beat, not a guess timer.
  const flow = useRoundFlow(outcome, flowFallbackMs('dragon-tiger'), onRoundComplete);
  // Round-tagged deal phase: the tag is checked AT RENDER, so a new round's
  // first painted frame can never show the previous round's fully-dealt table
  // for the gap between paint and the reset effect.
  const [dealState, setDealState] = useState({ round: 0, value: 0 }); // 0 = none, 1 = dragon, 2 = tiger, 3 = reveal
  const deal = dealState.round === flow.roundKey ? dealState.value : 0;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // flow.outcome (sticky), not the raw prop — it parks at null between rounds.
  const res = flow.outcome as {
    dragon?: string;
    tiger?: string;
    outcome?: string;
    win?: boolean;
    multiplier?: number;
  } | null;
  const split = (s?: string) => ({
    rank: s?.slice(0, -1) ?? '?',
    suit: s?.slice(-1) ?? '♠',
  });
  const dragon = split(res?.dragon);
  const tiger = split(res?.tiger);
  const winSide = res?.outcome;
  const isPush = res?.outcome === 'tie';

  useEffect(() => {
    if (!res?.dragon) return;
    const round = flow.roundKey;
    setDealState({ round, value: 0 });
    timers.current.forEach(clearTimeout);
    timers.current = [];
    sound.play('card_deal');
    timers.current.push(
      setTimeout(() => {
        setDealState({ round, value: 1 });
        sound.play('card_deal');
      }, 200)
    );
    timers.current.push(
      setTimeout(() => {
        setDealState({ round, value: 2 });
        sound.play('card_deal');
      }, 700)
    );
    timers.current.push(
      setTimeout(() => {
        setDealState({ round, value: 3 });
        // The winner glow + spring-in is the final beat; when it has played,
        // the board declares the round complete.
        timers.current.push(setTimeout(() => flow.complete(), 550));
      }, 1400)
    );
    return () => timers.current.forEach(clearTimeout);
  }, [flow.roundKey, res?.dragon, res?.tiger]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <GameBackdrop accent={GOLD}>
      {/* D-101: scroll-safe wrapper */}
      <div className="relative w-full h-full overflow-y-auto">
        <div
          className="min-h-full w-full flex flex-col items-center justify-center gap-3 px-4 py-2"
          style={{
            background: 'radial-gradient(circle at 50% 45%, #1a2f0f 0%, #0a1408 75%)',
          }}
        >
          {/* arena */}
          <div className="flex items-end gap-8 sm:gap-14">
            <div className="text-center">
              <p
                className="t-label-xl font-black tracking-widest mb-3"
                style={{
                  color:
                    winSide === 'dragon' && deal >= 3 ? GOLD : 'rgba(255,255,255,0.4)',
                  textShadow:
                    winSide === 'dragon' && deal >= 3
                      ? `0 0 24px ${GOLD}66`
                      : undefined,
                }}
              >
                🐉 DRAGON
              </p>
              <DTCard
                {...dragon}
                flip={deal >= 1}
                delay={0}
                winner={deal >= 3 && winSide === 'dragon'}
                loser={deal >= 3 && winSide === 'tiger'}
              />
            </div>
            <div className="pb-10">
              <p
                className={`t-label-sm tracking-[0.3em] ${deal >= 2 && deal < 3 ? 'text-gold animate-pulse' : 'text-white/30'}`}
              >
                VS
              </p>
            </div>
            <div className="text-center">
              <p
                className="t-label-xl font-black tracking-widest mb-3"
                style={{
                  color:
                    winSide === 'tiger' && deal >= 3 ? GOLD : 'rgba(255,255,255,0.4)',
                  textShadow:
                    winSide === 'tiger' && deal >= 3 ? `0 0 24px ${GOLD}66` : undefined,
                }}
              >
                🐅 TIGER
              </p>
              <DTCard
                {...tiger}
                flip={deal >= 2}
                delay={80}
                winner={deal >= 3 && winSide === 'tiger'}
                loser={deal >= 3 && winSide === 'dragon'}
              />
            </div>
          </div>

          {/* result line */}
          <div className="min-h-[30px] text-center">
            {deal >= 3 && winSide && (
              <span
                className={`t-label-xl font-black tracking-widest animate-spring-in ${isPush ? 'text-gold' : 'text-green'}`}
                style={
                  isPush
                    ? { textShadow: `0 0 24px ${GOLD}66` }
                    : { textShadow: `0 0 24px ${GREEN}66` }
                }
              >
                {isPush ? '⚖️ TIE — BET RETURNED' : `${winSide.toUpperCase()} WINS!`}
              </span>
            )}
          </div>

          {/* bet chips */}
          <div className="flex gap-2">
            {(
              [
                ['dragon', '🐉 DRAGON 1.95×', GREEN],
                ['tiger', '🐅 TIGER 1.95×', RED],
                ['tie', '⚖️ TIE 12.46×', '#9b59ff'],
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
            multiplier={res?.multiplier}
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

export function DragonTigerBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  // Bets live on the table; the popup used to duplicate them.
  const bet = String(choices.bet ?? '');
  const pay: Record<string, number> = { dragon: 1.95, tiger: 1.95, tie: 12.46 };
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
      requirement={bet ? null : 'Tap DRAGON, TIGER or TIE on the table'}
      multiplier={pay[bet] ?? null}
    />
  );
}
