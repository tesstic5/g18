// apps/web/src/components/games/individual/LimboGame.tsx — rocket-style multiplier climber (D-095)
// D-095: a rocket rides the bar with a smoke trail, the target marker flashes
// when cleared, and the rocket explodes at the crash point. Server outcome drives it.
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { BetBar } from '../../BetBar';
import {
  GameBackdrop,
  ResultBanner,
  CountUp,
  GREEN,
  GOLD,
  BLUE,
  VIOLET,
} from '../game-kit';
import { useRoundFlow, animMs } from '../useRoundFlow';
import { sound } from '../../../lib/sound';
import type { GameVisualProps, GameBetPanelProps } from '../types';
import { PickPrompt } from '../board-kit';

const toPct = (m: number) =>
  Math.min(100, Math.max(0, (Math.log(m) / Math.log(100)) * 100));

export function LimboVisual({
  outcome,
  result,
  choices,
  setChoices,
  onRoundComplete,
}: GameVisualProps) {
  // Hold the result back until this game's animation has finished — the
  // banner used to fire the moment the server replied, spoiling the outcome
  // while the board was still animating.
  const flow = useRoundFlow(outcome, animMs('limbo') * 1.5, onRoundComplete);
  const [display, setDisplay] = useState(1);
  const [flying, setFlying] = useState(false);
  const [history, setHistory] = useState<number[]>([]);
  const [exploded, setExploded] = useState(false);
  const [targetHit, setTargetHit] = useState(false);
  const raf = useRef(0);
  // flow.outcome (the sticky round snapshot), NOT the raw `outcome` prop: the
  // page parks the prop at null while the next bet is in flight, and this
  // effect must survive that window.
  const res = flow.outcome as { result?: number } | null;

  useEffect(() => {
    if (!res?.result) return;
    const target = res.result;
    const roundResult = result; // capture at round start — never re-read stale
    setFlying(true);
    setExploded(false);
    setTargetHit(false);
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 2800);
      const m = 1 + (target - 1) * (1 - Math.pow(1 - p, 3));
      setDisplay(m);
      const tgt = Number(choices.target ?? 2);
      if (m >= tgt) {
        // functional update: the previous closure read the STALE `targetHit`
        // state, so the tick sound never fired when the target was cleared
        setTargetHit((already) => {
          if (!already) sound.play('tower_step');
          return true;
        });
      }
      if (p < 1) raf.current = requestAnimationFrame(step);
      else {
        setFlying(false);
        setHistory((h) => [target, ...h].slice(0, 8));
        if (roundResult === 'LOSE') {
          setExploded(true);
          sound.play('crash_boom');
        }
        // Board completion is explicit: the rocket has finished flying, NOW
        // the verdict may show. There is no timer elsewhere guessing this.
        flow.complete();
      }
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
    // Keyed on roundKey: an identical back-to-back outcome is still a NEW round.
    // The old `[res]` dep meant round 2 with the same crash point never re-ran
    // this effect — the board snapped straight to the answer at 0ms.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.roundKey]);

  const target = Number(choices.target ?? 2);
  const winChance = (1 / Math.max(1.01, target)) * 100;
  const pct = toPct(display);

  return (
    <GameBackdrop accent={VIOLET}>
      {/* D-101: scroll-safe wrapper — centers when it fits, scrolls on short viewports */}
      <div className="relative w-full h-full overflow-y-auto">
        <div className="min-h-full w-full flex flex-col items-center justify-center gap-3 px-4 py-2">
          <PickPrompt show={!outcome}>
            Slide to set the multiplier you are aiming for
          </PickPrompt>
          <div className="min-h-full w-full flex flex-col items-center justify-center gap-5 px-4">
            {/* big multiplier */}
            <div className="text-center">
              <p
                className={`t-hero tabular-nums ${flying ? 'text-gold' : result === 'WIN' ? 'text-green' : result === 'LOSE' ? 'text-white/30' : 'text-primary'}`}
                style={
                  flying
                    ? { textShadow: `0 0 40px ${GOLD}66` }
                    : result === 'WIN'
                      ? { textShadow: `0 0 40px ${GREEN}77` }
                      : undefined
                }
              >
                <CountUp value={display} decimals={2} duration={100} />×
              </p>
              <p className="t-label-sm text-white/45 mt-1">
                {flying
                  ? 'climbing…'
                  : result === 'WIN'
                    ? 'Target cleared! ✓'
                    : result === 'LOSE'
                      ? 'Crashed below target'
                      : 'Set your target'}
              </p>
            </div>

            {/* rocket bar */}
            <div className="w-full max-w-sm relative">
              <div className="relative h-3 rounded-full bg-white/8 overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-all duration-150"
                  style={{
                    width: `${pct}%`,
                    background: `linear-gradient(90deg, ${BLUE}, ${GOLD})`,
                    boxShadow: `0 0 14px ${GOLD}66`,
                  }}
                />
                {/* target marker */}
                <div
                  className="absolute inset-y-0 w-0.5 bg-white"
                  style={{ left: `${toPct(target)}%` }}
                />
                {targetHit && !exploded && (
                  <div
                    className="absolute -top-1.5 h-6 w-6 -ml-3 rounded-full border-2 border-gold animate-ping"
                    style={{ left: `${toPct(target)}%` }}
                  />
                )}
              </div>
              {/* rocket riding the bar + smoke trail */}
              {flying && (
                <div
                  className="absolute -top-4 -translate-y-1/2 transition-all duration-150"
                  style={{ left: `calc(${pct}% - 12px)` }}
                >
                  <span className="text-xl inline-block animate-rocket-bob drop-shadow-[0_0_10px_rgba(245,200,66,0.6)]">
                    🚀
                  </span>
                  <span className="absolute left-1/2 -translate-x-1/2 top-4 w-6 h-6 rounded-full blur-[6px] bg-orange-400/50 animate-pulse" />
                </div>
              )}
              {exploded && (
                <div
                  className="absolute -top-4 -translate-y-1/2 text-2xl animate-bomb-burst"
                  style={{ left: `calc(${pct}% - 14px)` }}
                >
                  💥
                </div>
              )}
              <div className="flex justify-between t-label-sm text-muted mt-1">
                <span>1×</span>
                <span className="text-gold">target {target.toFixed(2)}×</span>
                <span>100×</span>
              </div>
            </div>

            {/* target slider */}
            <div className="w-full max-w-sm">
              <div className="flex justify-between t-label-sm text-secondary mb-1">
                <span>Target multiplier</span>
                <span className="text-white/50">
                  Win chance {winChance.toFixed(1)}%
                </span>
              </div>
              <input
                type="range"
                min={1.01}
                max={100}
                step={0.1}
                value={target}
                onChange={(e) =>
                  setChoices({ ...choices, target: Number(e.target.value) })
                }
                className="w-full accent-gold"
              />
              {/* quick targets — the popup used to hold a second copy of this
              slider, so the same control existed in two places */}
              <div className="grid grid-cols-6 gap-1.5 mt-2">
                {[1.5, 2, 3, 5, 10, 50].map((t) => (
                  <button
                    key={t}
                    onClick={() => setChoices({ ...choices, target: t })}
                    className={`h-8 rounded-lg t-num-md transition-all ${Math.abs(target - t) < 0.05 ? 'bg-gold/15 border border-gold/40 text-gold' : 'bg-white/5 border border-white/8 text-white/60 active:scale-95'}`}
                  >
                    {t}×
                  </button>
                ))}
              </div>
            </div>

            {/* history */}
            <div className="flex flex-wrap justify-center gap-1.5 max-w-sm">
              {history.map((h, i) => (
                <span
                  key={i}
                  className={`px-2 py-0.5 rounded-md text-xs font-bold ${h >= target ? 'bg-green/15 text-green border border-green/25' : 'bg-red/15 text-red border border-red/25'}`}
                >
                  {h.toFixed(2)}×
                </span>
              ))}
              {history.length === 0 && (
                <span className="t-label-sm text-white/25">No rounds yet</span>
              )}
            </div>

            <ResultBanner
              ready={flow.revealed}
              roundKey={flow.roundKey}
              result={result}
              multiplier={
                result === 'WIN'
                  ? (flow.outcome as { multiplier?: number } | null)?.multiplier
                  : undefined
              }
              payout={
                result === 'WIN' ? (outcome as { payout?: number })?.payout : undefined
              }
            />

            <style>{`
          @keyframes rocketBob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-3px) } }
          .animate-rocket-bob { animation: rocketBob 0.4s ease-in-out infinite }
          @keyframes bombBurst { 0% { transform: scale(0.3); opacity: 0 } 40% { transform: scale(1.6); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
          .animate-bomb-burst { animation: bombBurst 0.5s cubic-bezier(0.2,0.9,0.3,1.4) forwards }
        `}</style>
          </div>
        </div>
      </div>
    </GameBackdrop>
  );
}

export function LimboBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  // The target slider lives on the board (it already did) — the popup used to
  // carry a duplicate copy of it, which meant two controls for one value.
  const target = Number(choices.target ?? 2);
  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel={`🚀 LAUNCH TO ${target.toFixed(2)}×`}
      selection={`Cash out at ${target.toFixed(2)}× · win chance ${(100 / target).toFixed(1)}%`}
      multiplier={0.99 * target}
    />
  );
}
