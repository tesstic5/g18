// apps/web/src/components/games/individual/LuckyNumberGame.tsx — slot-machine (D-095):
// three reels spin; the MIDDLE reel stops on the result while the sides land on
// neighbors; the target zone is highlighted on a 0–100 scale and the result
// marker glides into (or past) it. Server outcome drives the middle reel.
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { BetBar } from '../../BetBar';
import { GameBackdrop, ResultBanner, Glass, GREEN, RED, GOLD } from '../game-kit';
import { useRoundFlow, animMs, flowFallbackMs } from '../useRoundFlow';

// frames of blur before the reels start landing (70ms each)
const REEL_FRAMES = Math.floor((animMs('lucky-number') - 1300) / 70);
import { sound } from '../../../lib/sound';
import type { GameVisualProps, GameBetPanelProps } from '../types';
import { PickPrompt } from '../board-kit';

export function LuckyNumberVisual({
  outcome,
  result,
  choices,
  setChoices,
  onRoundComplete,
}: GameVisualProps) {
  // Hold the result back until the reels AND the zone marker have finished —
  // completion is the board's explicit call after the marker glide ends.
  const flow = useRoundFlow(
    outcome,
    flowFallbackMs('lucky-number') + 1200,
    onRoundComplete
  );
  const [reels, setReels] = useState<[number, number, number] | null>(null);
  const [finalN, setFinalN] = useState<number | null>(null);
  const [marker, setMarker] = useState(50);
  const [markerAnim, setMarkerAnim] = useState(false);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);
  const timeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  const betMin = Number(choices.betMin ?? 40);
  const betMax = Number(choices.betMax ?? 60);
  // flow.outcome (sticky), not the raw prop — it parks at null between rounds.
  const res = (flow.outcome as { result?: number } | null) ?? null;
  const inZone = finalN !== null && finalN >= betMin && finalN <= betMax;
  // Same pricing as the server (LuckyNumberGame.ts): narrower zone pays more.
  const zoneSize = Math.max(1, Math.min(100, betMax - betMin + 1));
  const zoneMult = Math.max(1.01, +(((0.96 - 1.9 / 100) * 100) / zoneSize).toFixed(2));

  useEffect(() => {
    if (res?.result === undefined) return;
    timers.current.forEach(clearInterval);
    timeouts.current.forEach(clearTimeout);
    const result = res.result!;
    // D-095: three reels spin; middle stops on the result, sides on neighbors
    let i = 0;
    const iv = setInterval(() => {
      setReels([
        1 + Math.floor(Math.random() * 100),
        1 + Math.floor(Math.random() * 100),
        1 + Math.floor(Math.random() * 100),
      ]);
      sound.play('wheel_tick');
      i++;
      if (i >= REEL_FRAMES) {
        clearInterval(iv);
        const left = Math.max(
          1,
          Math.min(100, result + (Math.random() < 0.5 ? -1 : 1))
        );
        const right = Math.max(
          1,
          Math.min(100, result + (Math.random() < 0.5 ? -2 : 2))
        );
        setReels([left, result, right]);
        setFinalN(result);
        // reels come to rest one after another, like a real slot
        timeouts.current.push(setTimeout(() => sound.play('wheel_stop'), 120));
        timeouts.current.push(setTimeout(() => sound.play('wheel_stop'), 620));
        timeouts.current.push(
          setTimeout(() => {
            sound.play('wheel_stop');
            setMarkerAnim(false);
            requestAnimationFrame(() => {
              setMarker(result);
              setMarkerAnim(true);
              // The marker glide (1200ms) is the last beat of the round — the
              // board reports completion when IT lands, not a guess timer.
              timeouts.current.push(setTimeout(() => flow.complete(), 1250));
            });
          }, 1120)
        );
      }
    }, 70);
    timers.current.push(iv);
    // Capture the ref ARRAYS now. Reading `timers.current` inside the cleanup
    // is unsafe: by the time cleanup runs the ref may point at a different
    // array (a new round started), so the previous round's interval/timeout
    // would never be cleared — a leak that keeps sounds and state updates
    // firing for a game the player already left.
    const pendingIntervals = timers.current;
    const pendingTimeouts = timeouts.current;
    return () => {
      pendingIntervals.forEach(clearInterval);
      pendingTimeouts.forEach(clearTimeout);
    };
    // roundKey ensures a NEW round re-fires this even if it produced an identical outcome
  }, [flow.roundKey, res?.result]); // eslint-disable-line react-hooks/exhaustive-deps

  const show = finalN ?? reels?.[1] ?? null;

  return (
    <GameBackdrop accent={GOLD}>
      {/* D-101: scroll-safe wrapper */}
      <div className="relative w-full h-full overflow-y-auto">
        <div className="min-h-full w-full flex flex-col items-center justify-center gap-4 px-4 py-2">
          <PickPrompt show={!outcome}>
            Drag the handles to widen or narrow your zone
          </PickPrompt>
          {/* slot machine */}
          <Glass className="px-6 py-5 text-center relative overflow-hidden" glow={GOLD}>
            <p className="t-label-sm text-muted uppercase tracking-[0.25em] mb-2">
              Lucky Number
            </p>
            <div className="flex items-center justify-center gap-3">
              {[0, 1, 2].map((ri) => {
                const v = reels?.[ri as 0 | 1 | 2] ?? null;
                const isMiddle = ri === 1;
                const isResult = isMiddle && finalN !== null;
                return (
                  <div
                    key={ri}
                    className={`w-16 sm:w-20 h-20 sm:h-24 rounded-xl border-2 flex items-center justify-center overflow-hidden relative ${isResult ? (inZone ? 'border-green shadow-[0_0_24px_rgba(0,217,126,0.5)]' : 'border-red/50') : 'border-white/15'}`}
                    style={{ background: 'linear-gradient(180deg, #1a1a30, #10101f)' }}
                  >
                    {/* blur stripes for reel feel */}
                    <div className="absolute inset-x-0 top-0 h-4 bg-black/30" />
                    <div className="absolute inset-x-0 bottom-0 h-4 bg-black/30" />
                    <span
                      className={`t-hero tabular-nums ${isResult ? (inZone ? 'text-green' : 'text-red') : 'text-gold/80 blur-[1px]'}`}
                      style={
                        isResult && inZone
                          ? { textShadow: `0 0 24px ${GREEN}77` }
                          : isResult
                            ? { textShadow: `0 0 24px ${RED}66` }
                            : undefined
                      }
                    >
                      {v === null ? '••' : String(v).padStart(2, '0')}
                    </span>
                  </div>
                );
              })}
            </div>
            {finalN !== null && (
              <p
                className={`t-headline mt-3 animate-spring-in ${inZone ? 'text-green' : 'text-red'}`}
              >
                {inZone
                  ? 'IN THE ZONE! ✓'
                  : `Missed by ${Math.min(Math.abs(betMin - finalN), Math.abs(betMax - finalN))}`}
              </p>
            )}
            {finalN === null && show === null && (
              <p className="t-label-sm text-white/50 animate-pulse mt-2">spinning…</p>
            )}
          </Glass>

          {/* target zone scale */}
          <div className="w-full max-w-sm">
            <div className="relative h-4 rounded-full bg-white/8 overflow-hidden">
              {/* target zone */}
              <div
                className="absolute inset-y-0"
                style={{
                  left: `${betMin}%`,
                  width: `${betMax - betMin}%`,
                  background: `linear-gradient(90deg, ${GREEN}44, ${GREEN}88)`,
                  borderLeft: `2px solid ${GREEN}`,
                  borderRight: `2px solid ${GREEN}`,
                }}
              />
              {/* result marker */}
              {finalN !== null && (
                <div
                  className={`absolute -top-1.5 -bottom-1.5 w-1.5 rounded-full bg-white shadow-[0_0_10px_#fff] ${markerAnim ? 'transition-all duration-[1200ms] ease-out' : ''}`}
                  style={{ left: `calc(${marker}% - 3px)` }}
                />
              )}
            </div>
            <div className="flex justify-between t-label-sm text-muted mt-1">
              <span>1</span>
              <span className="text-green">
                zone {betMin}–{betMax}
              </span>
              <span>100</span>
            </div>
          </div>

          {/* THE ZONE IS SET HERE, on the scale it maps onto. These two sliders
            used to live inside the bet popup and the board only showed a
            read-only chip, so you picked your numbers on a different screen
            from the one showing the result. */}
          <div className="w-full max-w-sm space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="t-label-sm text-white/55">Your zone</span>
              <span className="t-num-md text-green font-bold">
                {betMin}–{betMax} · {zoneMult.toFixed(2)}×
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="t-label-sm text-white/35 w-8 shrink-0">from</span>
              <input
                type="range"
                min={1}
                max={100}
                value={betMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setChoices({ ...choices, betMin: v, betMax: Math.max(v, betMax) });
                }}
                className="flex-1 accent-green"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="t-label-sm text-white/35 w-8 shrink-0">to</span>
              <input
                type="range"
                min={1}
                max={100}
                value={betMax}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setChoices({ ...choices, betMax: v, betMin: Math.min(v, betMin) });
                }}
                className="flex-1 accent-green"
              />
            </div>
            {/* one-tap widths so a player never has to fight two sliders */}
            <div className="grid grid-cols-4 gap-1.5">
              {[1, 5, 10, 25].map((w) => {
                const mid = Math.round((betMin + betMax) / 2);
                const lo = Math.max(
                  1,
                  Math.min(100 - w + 1, mid - Math.floor((w - 1) / 2))
                );
                const active = betMax - betMin + 1 === w;
                return (
                  <button
                    key={w}
                    onClick={() =>
                      setChoices({ ...choices, betMin: lo, betMax: lo + w - 1 })
                    }
                    className={`h-8 rounded-lg t-label-sm transition-all ${active ? 'bg-green/15 border border-green/40 text-green' : 'bg-white/5 border border-white/8 text-white/55 active:scale-95'}`}
                  >
                    {w === 1 ? 'single' : `${w} wide`}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Show the multiplier the SERVER actually paid, not a locally guessed
            one -- the old `Math.max(2, 100 / width)` had nothing to do with the
            real payout and disagreed with the wallet on every round. */}
          <ResultBanner
            ready={flow.revealed}
            roundKey={flow.roundKey}
            result={result}
            multiplier={(outcome as { multiplier?: number })?.multiplier}
            payout={(outcome as { payout?: number })?.payout}
            partialRefund={(outcome as { partialRefund?: boolean })?.partialRefund}
            accent={GREEN}
          />
        </div>
      </div>
    </GameBackdrop>
  );
}

export function LuckyNumberBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  // The zone sliders moved onto the board, next to the 1-100 scale they set —
  // they used to be here in the popup while the board showed a read-only chip.
  // Pricing mirrors the server exactly (LuckyNumberGame.ts).
  const betMin = Number(choices.betMin ?? 40);
  const betMax = Number(choices.betMax ?? 60);
  const zoneSize = Math.max(1, Math.min(100, betMax - betMin + 1));
  const mult = Math.max(1.01, +(((0.96 - 1.9 / 100) * 100) / zoneSize).toFixed(2));
  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel={`SPIN FOR ${betMin}\u2013${betMax}`}
      selection={`Zone ${betMin}\u2013${betMax} · ${betMax - betMin + 1} of 100 numbers`}
      multiplier={mult}
    />
  );
}
