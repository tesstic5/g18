// apps/web/src/components/games/individual/StairsGame.tsx — REAL stairs (D-092):
// ONE bet per round → 10 steps → pick LEFT/RIGHT each step → multiplier grows →
// CASH OUT anytime or fall. Server decides every step's safe side.
'use client';
import React, { useEffect, useState } from 'react';
import { BetBar } from '../../BetBar';
import {
  GameBackdrop,
  ResultBanner,
  Glass,
  CountUp,
  GOLD,
  GREEN,
  BLUE,
} from '../game-kit';
import { sound } from '../../../lib/sound';
import { vibrate } from '../../../hooks';
import type { GameVisualProps, GameBetPanelProps } from '../types';
import { PickPrompt } from '../board-kit';

const STEPS = 10;
// Mirrors the server: one safe choice out of two, 4% house edge at every depth.
const LADDER = Array.from(
  { length: STEPS },
  (_, i) => +(0.96 / Math.pow(0.5, i + 1)).toFixed(2)
);

export function StairsVisual({
  outcome,
  result,
  config,
  choices,
  setChoices,
  session,
  onSessionStep,
  onSessionReset,
  sessionBusy,
}: GameVisualProps) {
  const steps = (session?.steps ?? []) as Array<{
    step?: number;
    pick?: number;
    safe?: boolean;
    stepReached?: number;
  }>;
  const active = session?.status === 'ACTIVE';
  const step = Number(session?.extra?.step ?? 0);
  const lost = result === 'LOSE';
  const [falling, setFalling] = useState(false);

  useEffect(() => {
    if (!lost) {
      setFalling(false);
      return;
    }
    setFalling(true);
    sound.play('tower_fall');
    const t = setTimeout(() => setFalling(false), 600);
    return () => clearTimeout(t);
  }, [lost]);

  const pick = (side: number) => {
    if (!active || sessionBusy) return;
    vibrate(10);
    void onSessionStep?.({ pick: side });
  };

  return (
    <GameBackdrop accent={BLUE}>
      {/* D-101: scroll-safe wrapper */}
      <div className="relative w-full h-full overflow-y-auto">
        <div
          className={`min-h-full w-full flex flex-col items-center justify-center gap-4 px-4 py-2 ${falling ? 'animate-tower-fall' : ''}`}
        >
          <PickPrompt show={!session}>
            Place a bet, then pick left or right on each step
          </PickPrompt>
          {/* step trail */}
          <div className="flex gap-1 sm:gap-2">
            {Array.from({ length: STEPS }).map((_, i) => {
              const p = steps[i];
              const isCurrent = active && i === step;
              return (
                <div key={i} className="flex flex-col items-center gap-1">
                  <span
                    className={`h-5 w-5 sm:h-9 sm:w-9 rounded-full flex items-center justify-center text-xs sm:text-sm border transition-all duration-300 ${p ? (p.safe ? 'bg-green/20 border-green/50 text-green shadow-[0_0_12px_rgba(0,217,126,0.35)]' : 'bg-red/20 border-red/50 text-red animate-bomb-burst') : isCurrent ? 'bg-gold/15 border-gold/60 text-gold animate-pulse' : 'bg-white/5 border-white/10 text-white/25'}`}
                  >
                    {p ? (p.safe ? '✓' : '✕') : isCurrent ? '●' : i + 1}
                  </span>
                  <span className="t-label-sm text-muted text-[9px]">
                    {p?.safe ? LADDER[i]?.toFixed(1) : ''}
                  </span>
                </div>
              );
            })}
          </div>

          {/* status */}
          <Glass className="px-6 py-3 text-center" glow={GOLD}>
            <p className="t-label-sm text-muted uppercase tracking-widest">
              Step {Math.min(step + 1, STEPS)}/{STEPS}
            </p>
            {active ? (
              <p
                className="t-headline"
                style={{ color: GOLD, textShadow: `0 0 20px ${GOLD}55` }}
              >
                <CountUp
                  value={session!.currentMultiplier}
                  decimals={2}
                  duration={400}
                />
                ×
                <span className="t-label-sm text-muted ml-2">
                  next {session!.nextMultiplier.toFixed(2)}×
                </span>
              </p>
            ) : (
              <p
                className={`t-headline ${lost ? 'text-red' : session ? 'text-green' : 'text-white/40'}`}
              >
                {lost ? 'FELL!' : session ? 'CASHED OUT ✓' : 'Place a bet to climb'}
              </p>
            )}
          </Glass>

          {/* choice buttons */}
          <div className="flex gap-5">
            {[0, 1].map((side) => (
              <button
                key={side}
                onClick={() => pick(side)}
                disabled={!active || sessionBusy}
                className="w-28 h-14 sm:w-32 sm:h-16 rounded-2xl border-2 font-black tracking-wider t-label-sm sm:t-label-lg transition-all active:scale-95 disabled:opacity-40
                bg-gradient-to-b from-[#232342] to-[#12122a] border-white/15 text-white/75 hover:border-gold/60 hover:text-gold hover:shadow-[0_0_24px_rgba(245,200,66,0.25)]"
              >
                {side === 0 ? '← LEFT' : 'RIGHT →'}
              </button>
            ))}
          </div>

          {/* Fall overlay — see TowerGame: "FELL!" used to be printed in the exact
            spot the shared ResultBanner prints "YOU LOSE", so the two texts
            overlapped and neither could be read. Only the reset button lives
            here now, below the centre line. */}
          {lost && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-end pb-8 bg-red/10 backdrop-blur-[2px]">
              <button
                onClick={() => onSessionReset?.()}
                className="btn-primary px-7 h-11 rounded-xl shadow-[0_6px_24px_rgba(0,217,126,0.4)]"
              >
                ▶ Play Again
              </button>
            </div>
          )}

          <ResultBanner
            result={result}
            multiplier={
              result === 'WIN'
                ? (outcome as { multiplier?: number })?.multiplier
                : undefined
            }
            payout={
              result === 'WIN' ? (outcome as { payout?: number })?.payout : undefined
            }
            accent={GREEN}
          />

          <style>{`
          @keyframes towerFall { 0%,100% { transform: translate(0,0) } 25% { transform: translate(-8px,4px) } 50% { transform: translate(6px,-6px) } 75% { transform: translate(-5px,2px) } }
          .animate-tower-fall { animation: towerFall 0.55s ease-in-out }
          @keyframes bombBurst { 0% { transform: scale(0.3); opacity: 0 } 40% { transform: scale(1.5); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
          .animate-bomb-burst { animation: bombBurst 0.5s cubic-bezier(0.2,0.9,0.3,1.4) forwards }
        `}</style>
        </div>
      </div>
    </GameBackdrop>
  );
}

export function StairsBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
}: GameBetPanelProps) {
  return (
    <BetBar
      minBet={minBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel="START CLIMB"
      selection="Pick left or right on each step · cash out any time"
    />
  );
}
