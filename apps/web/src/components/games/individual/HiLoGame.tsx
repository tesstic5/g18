// apps/web/src/components/games/individual/HiLoGame.tsx — REAL hi-lo (D-092):
// ONE bet per round → a card is dealt → guess HIGHER/LOWER → correct guesses
// compound the multiplier → CASH OUT anytime or bust. Tie = bust (real rules).
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { BetBar } from '../../BetBar';
import {
  GameBackdrop,
  ResultBanner,
  Glass,
  CountUp,
  GOLD,
  GREEN,
  RED,
} from '../game-kit';
import { sound } from '../../../lib/sound';
import { vibrate } from '../../../hooks';
import type { GameVisualProps, GameBetPanelProps } from '../types';
import { PickPrompt } from '../board-kit';

const SUIT_COLOR: Record<string, string> = {
  '♠': '#e8e8f0',
  '♥': '#ff3b5c',
  '♦': '#ff3b5c',
  '♣': '#e8e8f0',
};

function CardFace({
  rank,
  suit,
  size = 'lg',
  dim = false,
}: {
  rank: string;
  suit: string;
  size?: 'lg' | 'sm';
  dim?: boolean;
}) {
  const color = SUIT_COLOR[suit] ?? '#fff';
  return (
    <div
      className={`rounded-xl bg-gradient-to-br from-white to-slate-200 shadow-[0_10px_30px_rgba(0,0,0,0.5),inset_0_-3px_6px_rgba(0,0,0,0.12)] flex flex-col items-center justify-center relative select-none ${dim ? 'opacity-40 grayscale' : ''}`}
      style={{ width: size === 'lg' ? 84 : 64, height: size === 'lg' ? 118 : 92 }}
    >
      <span className="absolute top-1 left-2 t-label-sm font-black" style={{ color }}>
        {rank}
      </span>
      <span
        className={`${size === 'lg' ? 'text-4xl' : 'text-2xl'} font-black`}
        style={{ color }}
      >
        {suit}
      </span>
      <span
        className="absolute bottom-1 right-2 t-label-sm font-black rotate-180"
        style={{ color }}
      >
        {rank}
      </span>
    </div>
  );
}

export function HiLoVisual({
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
    current?: string;
    currentSuit?: string;
    next?: string;
    suit?: string;
    guess?: string;
    win?: boolean;
    multiplier?: number;
    probability?: number;
  }>;
  const active = session?.status === 'ACTIVE';
  const streak = Number(session?.extra?.streak ?? 0);
  const currentRank = String(session?.extra?.currentRank ?? '?');
  const currentSuit = String(session?.extra?.currentSuit ?? '♠');
  const lost = result === 'LOSE';
  const [dealing, setDealing] = useState(false);
  const [flash, setFlash] = useState<'win' | 'lose' | null>(null);
  const dealtOnce = useRef(false);

  // animate the newest deal: card flip-in + result flash
  const lastStep = steps[steps.length - 1];
  useEffect(() => {
    if (!lastStep) return;
    setDealing(true);
    sound.play('card_deal');
    setFlash(lastStep.win ? 'win' : 'lose');
    const t1 = setTimeout(() => setDealing(false), 550);
    const t2 = setTimeout(() => setFlash(null), 900);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [steps.length, lastStep?.next, lastStep?.guess, lastStep?.suit]); // eslint-disable-line react-hooks/exhaustive-deps

  // first card entrance
  useEffect(() => {
    if (session && !dealtOnce.current) {
      dealtOnce.current = true;
      sound.play('card_deal');
    }
    if (!session) dealtOnce.current = false;
  }, [session?.roundId]); // eslint-disable-line react-hooks/exhaustive-deps

  // An Ace has nothing above it and a 2 has nothing below it, so that direction
  // can never be won. The server rejects the step; hide the button so the
  // player is never offered a bet that cannot pay (it used to be shown with a
  // quoted 1.94x payout).
  const noHigher = currentRank === 'A';
  const noLower = currentRank === '2';

  const guess = (g: 'higher' | 'lower') => {
    if (!active || sessionBusy || dealing) return;
    vibrate(10);
    void onSessionStep?.({ guess: g });
  };

  const probText =
    lastStep?.probability !== undefined
      ? `${lastStep.probability.toFixed(0)}% chance`
      : '';

  return (
    <GameBackdrop accent={GOLD}>
      {/* D-101: scroll-safe wrapper */}
      <div className="relative w-full h-full overflow-y-auto">
        <div className="min-h-full w-full flex flex-col items-center justify-center gap-3 px-4 py-2">
          <PickPrompt show={!session}>
            Place a bet, then guess higher or lower each card
          </PickPrompt>
          {/* cards row */}
          <div className="flex items-center gap-4">
            {/* current card */}
            {session ? (
              <div
                className={`${dealing ? 'animate-card-dealt-out' : 'animate-card-in'} ${flash === 'win' ? 'drop-shadow-[0_0_24px_rgba(0,217,126,0.7)]' : flash === 'lose' ? 'grayscale opacity-50' : ''}`}
              >
                <CardFace rank={currentRank} suit={currentSuit} dim={lost} />
              </div>
            ) : (
              <div className="w-[92px] h-[130px] rounded-xl border-2 border-dashed border-white/15 flex items-center justify-center text-white/25 text-3xl">
                ?
              </div>
            )}
            {/* next card (dealing) */}
            {dealing && lastStep?.next && (
              <div className="animate-card-flip-in">
                <CardFace rank={lastStep.next} suit={lastStep.suit ?? '♠'} />
              </div>
            )}
          </div>

          {/* streak + multiplier */}
          <Glass className="px-6 py-2 text-center" glow={GOLD}>
            <p className="t-label-sm text-muted uppercase tracking-widest">
              Streak {streak} · {probText || 'guess the next card'}
            </p>
            <p
              className="t-headline"
              style={{
                color: active ? GOLD : lost ? RED : GREEN,
                textShadow: `0 0 20px ${active ? GOLD : lost ? RED : GREEN}55`,
              }}
            >
              {active ? (
                <>
                  <CountUp
                    value={session!.currentMultiplier}
                    decimals={2}
                    duration={400}
                  />
                  ×
                </>
              ) : lost ? (
                'BUST'
              ) : session ? (
                'CASHED OUT ✓'
              ) : (
                'Deal to start'
              )}
            </p>
          </Glass>

          {/* guess buttons */}
          <div className="flex gap-4 w-full max-w-xs">
            <button
              onClick={() => guess('lower')}
              disabled={!active || sessionBusy || dealing || noLower}
              title={noLower ? 'Nothing is lower than a 2' : undefined}
              className="flex-1 h-14 rounded-2xl border-2 font-black tracking-wider t-label-lg transition-all active:scale-95 disabled:opacity-40 bg-gradient-to-b from-[#3a1420] to-[#1f0a12] border-red/40 text-red hover:border-red hover:shadow-[0_0_24px_rgba(255,59,92,0.3)]"
            >
              {noLower ? '▼ — ' : '▼ LOWER'}
            </button>
            <button
              onClick={() => guess('higher')}
              disabled={!active || sessionBusy || dealing || noHigher}
              title={noHigher ? 'Nothing is higher than an Ace' : undefined}
              className="flex-1 h-14 rounded-2xl border-2 font-black tracking-wider t-label-lg transition-all active:scale-95 disabled:opacity-40 bg-gradient-to-b from-[#0e3d2a] to-[#0a2418] border-green/40 text-green hover:border-green hover:shadow-[0_0_24px_rgba(0,217,126,0.3)]"
            >
              {noHigher ? '▲ — ' : '▲ HIGHER'}
            </button>
          </div>

          {/* bust overlay */}
          {lost && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-red/10 backdrop-blur-[2px]">
              <div className="text-center">
                <p
                  className="t-title text-red animate-spring-in"
                  style={{ textShadow: '0 0 40px rgba(255,59,92,0.6)' }}
                >
                  WRONG GUESS!
                </p>
                <button
                  onClick={() => onSessionReset?.()}
                  className="btn-primary mt-3 px-7 h-11 rounded-xl"
                >
                  ▶ Play Again
                </button>
              </div>
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
          @keyframes cardIn { 0% { transform: translateY(-40px) scale(0.8); opacity: 0 } 60% { transform: translateY(4px) scale(1.02) } 100% { transform: translateY(0) scale(1); opacity: 1 } }
          .animate-card-in { animation: cardIn 0.45s cubic-bezier(0.2,0.9,0.3,1.2) forwards }
          @keyframes cardFlipIn { 0% { transform: rotateY(90deg) translateX(20px); opacity: 0 } 100% { transform: rotateY(0) translateX(0); opacity: 1 } }
          .animate-card-flip-in { animation: cardFlipIn 0.5s cubic-bezier(0.2,0.9,0.3,1.3) forwards }
          @keyframes cardDealtOut { 0% { transform: translateX(0) } 100% { transform: translateX(-14px) } }
          .animate-card-dealt-out { animation: cardDealtOut 0.3s ease-out forwards }
        `}</style>
        </div>
      </div>
    </GameBackdrop>
  );
}

export function HiLoBetPanel({ onBet, minBet, balance, isLoading }: GameBetPanelProps) {
  return (
    <BetBar
      minBet={minBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel="DEAL FIRST CARD"
      selection="Guess higher or lower each card · cash out any time"
    />
  );
}
