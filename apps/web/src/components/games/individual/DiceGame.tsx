// apps/web/src/components/games/individual/DiceGame.tsx — REAL 3D dice (D-095):
// a 3D cube tumbles through random rotations and settles on the face matching
// the rolled number; the win-zone bar shows a marker gliding to the roll; the
// number counts up. Server outcome drives everything.
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { BetBar } from '../../BetBar';
import { Segment } from '../types';
import { BoardSlider, PickPrompt } from '../board-kit';
import { GameBackdrop, ResultBanner, GREEN, RED, GOLD } from '../game-kit';
import { useRoundFlow, animMs, flowFallbackMs } from '../useRoundFlow';

const DICE_MS = animMs('dice');
import { sound } from '../../../lib/sound';
import type { GameVisualProps, GameBetPanelProps } from '../types';

// CSS 3D cube — which rotation shows face f to the front
function Pip({ x, y }: { x: string; y: string }) {
  return (
    <span
      className="absolute w-[16%] h-[16%] rounded-full bg-[#1a1a2e]"
      style={{ left: x, top: y, transform: 'translate(-50%,-50%)' }}
    />
  );
}
function DieFace({ n }: { n: number }) {
  const dots: Record<number, Array<[string, string]>> = {
    1: [['50%', '50%']],
    2: [
      ['30%', '30%'],
      ['70%', '70%'],
    ],
    3: [
      ['30%', '30%'],
      ['50%', '50%'],
      ['70%', '70%'],
    ],
    4: [
      ['30%', '30%'],
      ['70%', '30%'],
      ['30%', '70%'],
      ['70%', '70%'],
    ],
    5: [
      ['30%', '30%'],
      ['70%', '30%'],
      ['50%', '50%'],
      ['30%', '70%'],
      ['70%', '70%'],
    ],
    6: [
      ['30%', '28%'],
      ['70%', '28%'],
      ['30%', '50%'],
      ['70%', '50%'],
      ['30%', '72%'],
      ['70%', '72%'],
    ],
  };
  return (
    <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-white to-slate-200 border border-black/10 flex items-center justify-center">
      {(dots[n] ?? dots[1]!).map(([x, y], i) => (
        <Pip key={i} x={x} y={y} />
      ))}
    </div>
  );
}

export function DiceGameVisual({
  outcome,
  result,
  config,
  choices,
  setChoices,
  onRoundComplete,
}: GameVisualProps) {
  // Hold the result back until this game's animation has finished — the
  // reveal comes from the board's own `flow.complete()` at the end of the
  // marker glide; the fallback budget is only a dead-man's switch.
  const flow = useRoundFlow(outcome, flowFallbackMs('dice'), onRoundComplete);
  const [display, setDisplay] = useState<number | null>(null);
  const [rolling, setRolling] = useState(false);
  const [cubeRot, setCubeRot] = useState('rotateX(0deg) rotateY(0deg)');
  const [marker, setMarker] = useState(0); // win-zone marker position (0-100)
  const [markerAnim, setMarkerAnim] = useState(false);
  const tumbleTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const over = Boolean(choices.over);
  const target = Number(choices.target ?? 50.5);
  const winZoneWidth = over ? 100 - target : target;
  const mult = 99 / Math.max(1, winZoneWidth);

  useEffect(() => {
    // flow.outcome, not the raw `outcome` prop: the page nulls the prop for an
    // instant between rounds, and this effect re-runs on roundKey — reading the
    // prop meant round 2 hit `if (!outcome) return` and never animated.
    const live = flow.outcome as { resultNumber?: number } | null;
    if (!live) return;
    const to = Number(live.resultNumber ?? 0);
    const finalFace = 1 + Math.floor((to / 100) * 6); // 0-100 -> 1-6
    setRolling(true);
    sound.play('coin_flip');

    // A real throw: the die tumbles fast, slows down, then settles. The old
    // version tumbled for 12 frames (~1s) and snapped — over before the eye
    // could follow it. Total is now DICE_MS, matched to the reveal gate so the
    // number is never announced before the die has stopped.
    const TUMBLE_MS = DICE_MS - 900;
    const start = performance.now();
    let i = 0;
    const step = () => {
      const elapsed = performance.now() - start;
      if (elapsed >= TUMBLE_MS) {
        if (tumbleTimer.current) clearInterval(tumbleTimer.current);
        // settle on the face that matches the roll, with a last couple of spins
        setCubeRot(
          `rotateX(${1080 + (finalFace === 5 ? 90 : finalFace === 6 ? -90 : 0)}deg) rotateY(${1080 + (finalFace === 2 ? 180 : finalFace === 3 ? -90 : finalFace === 4 ? 90 : 0)}deg)`
        );
        finalTimer.current = setTimeout(() => {
          // The die has visibly stopped — only NOW print the roll. Showing the
          // number the moment the tumble ended let the board announce the
          // answer while the settle bounce was still playing.
          setDisplay(to);
          setRolling(false);
          sound.play('plinko_land');
          setMarkerAnim(false);
          requestAnimationFrame(() => {
            setMarker(to);
            setMarkerAnim(true);
            // The marker glide is the last beat of the round — report
            // completion explicitly when it lands.
            if (doneTimer.current) clearTimeout(doneTimer.current);
            doneTimer.current = setTimeout(() => flow.complete(), 1100);
          });
        }, 750);
        return;
      }
      // spin fast at first, visibly slowing as it runs out of energy
      setCubeRot(
        `rotateX(${Math.floor(Math.random() * 360)}deg) rotateY(${Math.floor(Math.random() * 360)}deg)`
      );
      setDisplay(Math.random() * 100);
      i++;
    };
    // re-arm the interval with a growing gap so the tumble decelerates
    let gap = 70;
    const arm = () => {
      if (tumbleTimer.current) clearInterval(tumbleTimer.current);
      tumbleTimer.current = setInterval(() => {
        step();
        const elapsed = performance.now() - start;
        const want = 70 + 150 * Math.pow(elapsed / TUMBLE_MS, 2);
        if (Math.abs(want - gap) > 25 && elapsed < TUMBLE_MS) {
          gap = want;
          arm();
        }
      }, gap);
    };
    arm();

    return () => {
      if (tumbleTimer.current) clearInterval(tumbleTimer.current);
      if (finalTimer.current) clearTimeout(finalTimer.current);
      if (doneTimer.current) clearTimeout(doneTimer.current);
    };
    // roundKey ensures a NEW round re-fires this even if it produced an identical outcome
  }, [flow.roundKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <GameBackdrop accent={GOLD}>
      {/* D-096: scroll-safe wrapper */}
      <div className="relative w-full h-full overflow-y-auto">
        <div className="min-h-full w-full flex flex-col items-center justify-center gap-2 px-4 py-1.5">
          <PickPrompt show={!outcome}>
            Slide the target or switch Over/Under to change your odds
          </PickPrompt>
          {/* big display + 3D dice */}
          <div className="text-center">
            <div className="flex items-center gap-4 sm:gap-8 justify-center">
              {/* 3D cube (faces are translateZ(48px) — keep ≥96px cube) */}
              <div
                className="relative w-20 h-20 sm:w-28 sm:h-28"
                style={{ perspective: 500 }}
              >
                <div
                  className="absolute inset-0 rounded-lg animate-float-slow"
                  style={{
                    background:
                      'radial-gradient(circle, rgba(245,200,66,0.15), transparent 70%)',
                    filter: 'blur(4px)',
                  }}
                />
                <div
                  className="relative w-full h-full transition-transform duration-[650ms] ease-out"
                  style={{ transformStyle: 'preserve-3d', transform: cubeRot }}
                >
                  {[1, 2, 3, 4, 5, 6].map((f) => (
                    <div
                      key={f}
                      className="absolute inset-0"
                      style={{
                        transform:
                          f === 1
                            ? 'translateZ(40px)'
                            : f === 2
                              ? 'rotateY(180deg) translateZ(40px)'
                              : f === 3
                                ? 'rotateY(-90deg) translateZ(40px)'
                                : f === 4
                                  ? 'rotateY(90deg) translateZ(40px)'
                                  : f === 5
                                    ? 'rotateX(90deg) translateZ(40px)'
                                    : 'rotateX(-90deg) translateZ(40px)',
                      }}
                    >
                      <DieFace n={f} />
                    </div>
                  ))}
                </div>
              </div>
              {/* number */}
              <p
                className={`text-5xl sm:text-6xl font-black tabular-nums ${rolling || !flow.revealed ? 'text-white/70' : result === 'WIN' ? 'text-green' : result === 'LOSE' ? 'text-red' : 'text-primary'}`}
                style={
                  flow.revealed && result === 'WIN'
                    ? { textShadow: `0 0 30px ${GREEN}66` }
                    : undefined
                }
              >
                {display === null ? '—' : display.toFixed(2)}
              </p>
            </div>
            {rolling && (
              <p className="t-label-sm text-white/55 mt-2 animate-pulse">ROLLING…</p>
            )}
          </div>

          {/* win-zone bar with gliding marker */}
          <div className="w-full max-w-md">
            <div className="flex gap-2 mb-1.5">
              <Segment
                options={['over', 'under'] as const}
                value={over ? 'over' : 'under'}
                labels={{ over: '↑ Roll Over', under: '↓ Roll Under' }}
                onChange={(v) => setChoices({ ...choices, over: v === 'over' })}
              />
            </div>
            <div className="relative h-7">
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 rounded-full overflow-hidden flex shadow-[inset_0_1px_3px_rgba(0,0,0,0.5)]">
                <div
                  className="h-full"
                  style={{
                    width: `${winZoneWidth}%`,
                    background: `linear-gradient(90deg, ${GREEN}55, ${GREEN}99)`,
                  }}
                />
                <div
                  className="h-full"
                  style={{
                    width: `${100 - winZoneWidth}%`,
                    background: `linear-gradient(90deg, ${RED}66, ${RED}99)`,
                  }}
                />
              </div>
              {/* target marker */}
              <div
                className="absolute top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white border-[3px] flex items-center justify-center"
                style={{
                  left: `calc(${target}% - 14px)`,
                  borderColor: GOLD,
                  boxShadow: `0 0 16px ${GOLD}88`,
                }}
              >
                <span className="text-[9px] font-bold text-[#1a1a2e]">
                  {target.toFixed(0)}
                </span>
              </div>
              {/* gliding roll marker */}
              {display !== null && !rolling && (
                <div
                  className={`absolute -top-1 bottom-0 w-1.5 rounded-full bg-white shadow-[0_0_10px_#fff] ${markerAnim ? 'transition-all duration-[1100ms] ease-out' : ''}`}
                  style={{ left: `calc(${marker}% - 3px)` }}
                />
              )}
            </div>
            <div className="flex justify-between t-label-sm text-muted mt-1">
              <span>0</span>
              <span>50</span>
              <span>100</span>
            </div>

            {/* THE TARGET LIVES HERE, on the bar it controls. It used to be a
              slider inside the bet popup, so you set your odds on one screen
              and played on another. */}
            <div className="mt-2">
              <BoardSlider
                label={over ? 'Win if the roll is ABOVE' : 'Win if the roll is BELOW'}
                value={target}
                min={2}
                max={98}
                step={0.5}
                onChange={(v) => setChoices({ ...choices, target: v })}
                disabled={rolling}
                hint={`${target.toFixed(2)} · ${mult.toFixed(2)}×`}
              />
            </div>
          </div>

          {/* stats */}
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 rounded-full border border-white/10 bg-white/[0.04] t-label-sm text-white/80">
              Win <b className="text-white/90">{winZoneWidth.toFixed(2)}%</b>
            </span>
            <span
              className="px-3 py-1 rounded-full border border-white/10 bg-white/[0.04] t-label-sm"
              style={{ color: GOLD }}
            >
              {mult.toFixed(2)}×
            </span>
            <span
              className="px-3 py-1 rounded-full border border-white/10 bg-white/[0.04] t-label-sm"
              style={{
                color: !flow.revealed
                  ? '#fff'
                  : result === 'WIN'
                    ? GREEN
                    : result === 'LOSE'
                      ? RED
                      : '#fff',
              }}
            >
              {display === null ? '—' : display.toFixed(2)}
            </span>
          </div>

          <ResultBanner
            ready={flow.revealed}
            roundKey={flow.roundKey}
            result={result}
            multiplier={mult}
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

export function DiceGameBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  // No game controls here any more — over/under and the target both live on the
  // board, next to the win-zone bar they actually affect.
  const over = Boolean(choices.over);
  const target = Number(choices.target ?? 50.5);
  const fair = 99 / Math.max(1, over ? 100 - target : target);

  // H-4: the extreme targets are a silent half-price trap. "Over 98" is
  // mathematically a 49.5x bet, but the game caps payouts at maxWinMultiplier
  // (25x by default) — so it silently settled at half the advertised price, a
  // 49.3% RTP round with nothing on screen admitting it. Say so BEFORE the
  // player commits, and show the price they will actually be paid.
  const cap = Number(config?.maxWinMultiplier ?? 0);
  const capped = cap > 0 && fair > cap;
  const mult = capped ? cap : fair;

  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel={`ROLL ${over ? 'OVER' : 'UNDER'} ${target.toFixed(2)}`}
      selection={`Roll ${over ? 'OVER' : 'UNDER'} ${target.toFixed(2)} · win chance ${(over ? 100 - target : target).toFixed(1)}%`}
      multiplier={mult}
    >
      {capped && (
        <p className="t-label-sm text-red/80 leading-snug px-0.5">
          ⚠ This game pays at most {cap.toFixed(2)}×. At {over ? 'over' : 'under'}{' '}
          {target.toFixed(2)} the fair price is {fair.toFixed(2)}× — you would be paid{' '}
          {cap.toFixed(2)}×. Move the target back for full value.
        </p>
      )}
    </BetBar>
  );
}
