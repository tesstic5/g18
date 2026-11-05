// apps/web/src/components/games/individual/CoinFlipGame.tsx — call it, then toss it.
//
// The pick used to be a small segmented control that was easy to miss, and the
// stake lived behind a modal, so the whole game was "tap PLAY, watch a coin".
// Now you CALL THE SIDE by tapping the big HEADS / TAILS faces on the board, the
// coin previews your call, and the action button says what it needs.
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { BetBar } from '../../BetBar';
import { GameBackdrop, ResultBanner, Glass, GOLD, GREEN, RED } from '../game-kit';
import { useRoundFlow, flowFallbackMs } from '../useRoundFlow';
import { PickRow, PickPrompt } from '../board-kit';
import { sound } from '../../../lib/sound';
import type { GameVisualProps, GameBetPanelProps } from '../types';

export function CoinFlipVisual({
  outcome,
  result,
  choices,
  setChoices,
  config,
  onRoundComplete,
}: GameVisualProps) {
  // Hold the result back until this game's animation has finished — the
  // banner used to fire the moment the server replied, spoiling the outcome
  // while the board was still animating.
  const flow = useRoundFlow(outcome, flowFallbackMs('coin-flip'), onRoundComplete);
  const [phase, setPhase] = useState<'idle' | 'toss' | 'landed'>('idle');
  const [showSide, setShowSide] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ side: string; win: boolean }>>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // CUMULATIVE spin — the wheel's pattern. An absolute rotateY(1440deg) target
  // was the cause of "round 2 has no animation": the coin rested at 1440/1620,
  // so round 2 travelled at most a lazy half-turn (or ZERO when the same side
  // repeated) and the stamp appeared on a motionless coin. With a cumulative
  // target every toss spins forward ≥1440° no matter what the last side was.
  const spinRef = useRef(0);
  const [spin, setSpin] = useState(0);
  const side = (outcome as { side?: string })?.side ?? 'heads';
  const win = result === 'WIN';
  const payout = Number(
    (config.configJson as { payout?: number } | undefined)?.payout ?? 1.92
  );

  // After the round completes, let the stamp/banner breathe, then return the
  // board to a genuinely fresh idle: call prompt back, pick row re-enabled.
  // Without this the board stayed frozen in "landed" forever — the prompt never
  // re-showed after round 1. The landed stamp itself stays until the NEXT toss
  // clears it (a result record is good UX; the sweep also asserts on it late).
  useEffect(() => {
    if (!flow.revealed) return;
    const t = setTimeout(() => setPhase('idle'), 900);
    return () => clearTimeout(t);
  }, [flow.revealed, flow.roundKey]);

  useEffect(() => {
    if (!outcome) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPhase('toss');
    setShowSide(null);
    sound.play('coin_flip');
    // Forward-only cumulative target: 4 full turns + however far the winning
    // face is from the CURRENT pose (never backwards, never zero).
    const desired = side === 'tails' ? 180 : 0;
    const next =
      spinRef.current +
      1440 +
      ((((desired - (spinRef.current % 360)) % 360) + 360) % 360);
    spinRef.current = next;
    setSpin(next);
    // toss up (450ms) → spin in air (900ms) → bounce (250ms) → stamp
    timers.current.push(setTimeout(() => sound.play('plinko_land'), 1350));
    timers.current.push(
      setTimeout(() => {
        setPhase('landed');
        setShowSide(side);
      }, 1600)
    );
    timers.current.push(
      setTimeout(() => {
        setHistory((h) => [{ side, win }, ...h].slice(0, 10));
        sound.play(result === 'WIN' ? 'win' : 'lose');
      }, 1900)
    );
    // The landing bounce (starts 1600ms, runs 500ms) is the last visible beat —
    // the round completes when IT ends, explicitly. No external timer guesses.
    timers.current.push(setTimeout(() => flow.complete(), 2150));
    return () => timers.current.forEach(clearTimeout);
    // roundKey ensures a NEW round re-fires this even if it produced an identical outcome
  }, [flow.roundKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Idle: the coin tilts to the side you are about to call (forward nudge ≤359°,
  // never a backwards spin). Toss/land: the cumulative spin owns the pose.
  const idlePose = (() => {
    const face = choices.choice === 'tails' ? 180 : 0;
    const cur = spinRef.current;
    return cur + ((((face - (cur % 360)) % 360) + 360) % 360);
  })();

  return (
    <GameBackdrop accent={GOLD}>
      {/* D-096: scroll-safe wrapper */}
      <div className="relative w-full h-full overflow-y-auto">
        <div className="min-h-full w-full flex flex-col items-center justify-center gap-3 px-4 py-1.5">
          {/* coin — D-096: slightly shorter so it fits short phones */}
          <div className="relative h-40 flex items-end justify-center">
            <div
              className="absolute inset-x-0 bottom-2 h-4 rounded-[50%] bg-black/40 blur-md transition-all duration-500"
              style={{
                transform: phase === 'toss' ? 'scale(0.5)' : 'scale(1)',
                opacity: phase === 'toss' ? 0.5 : 1,
              }}
            />
            <div
              className={`relative w-32 h-32 sm:w-40 sm:h-40 transition-all duration-500 ${phase === 'toss' ? 'animate-coin-toss' : phase === 'landed' ? 'animate-coin-bounce' : ''}`}
              style={{ perspective: 600 }}
            >
              <div
                className="w-full h-full rounded-full relative transition-transform duration-[1100ms]"
                style={{
                  transformStyle: 'preserve-3d',
                  // While idle the coin SHOWS the side you called, so your bet is
                  // visible on the object you are betting on.
                  transform:
                    phase === 'idle'
                      ? `translateY(0) rotateY(${idlePose}deg)`
                      : phase === 'toss'
                        ? `translateY(-90px) rotateY(${spin}deg)`
                        : `translateY(0) rotateY(${spin}deg)`,
                  transitionTimingFunction: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
                }}
              >
                <div className="absolute inset-0 rounded-full backface-hidden flex items-center justify-center flex-col bg-[radial-gradient(circle_at_50%_35%,#fff3b0,#f5c842_55%,#b8860b)] border-4 border-[#9a7209] shadow-[inset_0_4px_10px_rgba(255,255,255,0.5),0_12px_32px_rgba(0,0,0,0.6)]">
                  <span className="text-6xl drop-shadow">👑</span>
                  <span className="t-label-sm text-[#7a5c08] font-black tracking-widest mt-1">
                    HEADS
                  </span>
                </div>
                <div
                  className="absolute inset-0 rounded-full backface-hidden flex items-center justify-center flex-col bg-[radial-gradient(circle_at_50%_35%,#fff3b0,#f5c842_55%,#b8860b)] border-4 border-[#9a7209]"
                  style={{ transform: 'rotateY(180deg)' }}
                >
                  <span className="text-6xl drop-shadow">⭐</span>
                  <span className="t-label-sm text-[#7a5c08] font-black tracking-widest mt-1">
                    TAILS
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* CALL THE SIDE — the actual bet, made on the board */}
          <PickPrompt show={!choices.choice && phase === 'idle'}>
            Call heads or tails
          </PickPrompt>
          <div className="w-full max-w-[280px]">
            <PickRow
              columns={2}
              disabled={phase === 'toss'}
              value={(choices.choice as string) ?? null}
              onChange={(v) => {
                sound.play('bet_place');
                setChoices({ ...choices, choice: v });
              }}
              options={[
                {
                  value: 'heads',
                  label: 'HEADS',
                  sub: `${payout.toFixed(2)}×`,
                  icon: '👑',
                  color: GOLD,
                },
                {
                  value: 'tails',
                  label: 'TAILS',
                  sub: `${payout.toFixed(2)}×`,
                  icon: '⭐',
                  color: '#4d9fff',
                },
              ]}
            />
          </div>

          {/* result stamp */}
          {showSide && (
            <Glass className="px-6 py-2 animate-spring-in" glow={win ? GREEN : RED}>
              <span
                className={`t-label-xl font-black tracking-widest ${win ? 'text-green' : 'text-white/50'}`}
              >
                {showSide.toUpperCase()} — {win ? 'WIN ✓' : 'LOSE'}
              </span>
            </Glass>
          )}

          {/* streak strip */}
          {history.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5 max-w-xs">
              {history.map((h, i) => (
                <span
                  key={i}
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black border ${h.win ? 'bg-green/15 border-green/40 text-green' : 'bg-red/15 border-red/40 text-red/70'}`}
                >
                  {h.side === 'heads' ? 'H' : 'T'}
                </span>
              ))}
            </div>
          )}

          <ResultBanner
            ready={flow.revealed}
            roundKey={flow.roundKey}
            result={result}
            multiplier={(outcome as { multiplier?: number })?.multiplier}
            payout={
              result === 'WIN' ? (outcome as { payout?: number })?.payout : undefined
            }
            accent={GREEN}
          />
        </div>
      </div>
      <style>{`
        @keyframes coinToss { 0% { transform: translateY(0) } 100% { transform: translateY(-8px) } }
        .animate-coin-toss { animation: coinToss 0.45s ease-in-out infinite alternate }
        @keyframes coinBounce { 0% { transform: translateY(-14px) scale(1.06) } 40% { transform: translateY(0) scale(0.97) } 70% { transform: translateY(-5px) scale(1.02) } 100% { transform: translateY(0) scale(1) } }
        .animate-coin-bounce { animation: coinBounce 0.5s cubic-bezier(0.3,0.8,0.4,1) forwards }
        .backface-hidden { backface-visibility: hidden; -webkit-backface-visibility: hidden }
      `}</style>
    </GameBackdrop>
  );
}

export function CoinFlipBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  const called = choices.choice as string | undefined;
  const payout = Number(
    (config.configJson as { payout?: number } | undefined)?.payout ?? 1.92
  );
  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel={called ? `TOSS — ${called.toUpperCase()}` : 'TOSS THE COIN'}
      selection={called ? `Calling ${called.toUpperCase()}` : null}
      requirement={called ? null : 'Call heads or tails'}
      multiplier={payout}
    />
  );
}
