// apps/web/src/components/games/individual/ThimblesGame.tsx — tap the cup you want.
//
// The cups used to be rendered `disabled` and the pick was made from a
// "Cup 1 / Cup 2 / Cup 3" button list inside the bet popup, so the player never
// actually touched a cup — the whole point of the game. Now each cup IS the
// control: tap it to pick it, it lifts on hover and rings when chosen.
// The server still decides where the ball is at bet time (provably fair); the
// shuffle is the reveal animation.
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { BetBar } from '../../BetBar';
import { GameBackdrop, ResultBanner, Glass, GOLD, GREEN, RED } from '../game-kit';
import { useRoundFlow, animMs, flowFallbackMs } from '../useRoundFlow';

const SHUFFLE_MS = animMs('thimbles');
import { sound } from '../../../lib/sound';
import { PickPrompt } from '../board-kit';
import type { GameVisualProps, GameBetPanelProps } from '../types';

export function ThimblesVisual({
  outcome,
  result,
  choices,
  setChoices,
  onRoundComplete,
}: GameVisualProps) {
  // Hold the result back until the cup is actually lifted — completion is the
  // board's own call at the end of the reveal beat, never a guess timer.
  const flow = useRoundFlow(outcome, flowFallbackMs('thimbles'), onRoundComplete);
  const [shuffling, setShuffling] = useState(false);
  /** the round whose cups are revealed — tagged so a stale reveal from the
   * previous round can never paint into a new round's first frame */
  const [revealedRound, setRevealedRound] = useState(0);
  const [positions, setPositions] = useState<number[]>([0, 1, 2]); // cup id at each slot
  const [ballOut, setBallOut] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // flow.outcome (sticky), not the raw prop — the prop parks at null while the
  // next bet is in flight and must not cancel this round's shuffle.
  const ballCup = (flow.outcome as { ballCup?: number })?.ballCup ?? null;
  const revealed = revealedRound === flow.roundKey && ballCup !== null;
  // `cup` is undefined until the player taps one — that is what gates the CTA.
  const hasPick = choices.cup !== undefined && choices.cup !== null;
  const chosenCup = Number(choices.cup ?? -1);
  const win = result === 'WIN';

  // shuffle on new outcome — CSS-animated swaps between slots
  useEffect(() => {
    if (!flow.outcome || ballCup === null) return;
    const roundResult = win; // captured at round start — never re-read stale
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setBallOut(false);
    setShuffling(true);
    sound.play('card_deal');
    // A proper shuffle: 9 swaps filling the animation window. The old one
    // did up to 6 swaps at a fixed 320ms and could finish in under a second,
    // which is not long enough to lose track of the cup — the whole point.
    const swaps: Array<[number, number]> = [];
    while (swaps.length < 9) {
      const a = Math.floor(Math.random() * 3),
        b = Math.floor(Math.random() * 3);
      if (a !== b) swaps.push([a, b] as [number, number]);
    }
    const SWAP_MS = Math.max(150, Math.floor((SHUFFLE_MS - 500) / (swaps.length + 1)));
    swaps.forEach(([a, b], i) => {
      timers.current.push(
        setTimeout(
          () => {
            setPositions((p) => {
              const n = [...p];
              [n[a]!, n[b]!] = [n[b]!, n[a]!];
              return n;
            });
            sound.play('wheel_tick');
          },
          SWAP_MS * (i + 1)
        )
      );
    });
    // Shuffle done → one beat of suspense → lift the cups and pop the ball →
    // and ONLY THEN complete the round. The verdict can never outrun the show.
    timers.current.push(
      setTimeout(
        () => {
          setShuffling(false);
          setRevealedRound(flow.roundKey);
          setBallOut(true);
          sound.play(roundResult ? 'win' : 'lose');
          timers.current.push(setTimeout(() => flow.complete(), 650));
        },
        SWAP_MS * (swaps.length + 1) + 350
      )
    );
    return () => timers.current.forEach(clearTimeout);
    // roundKey ensures a NEW round re-fires this even if it produced an identical outcome
  }, [flow.roundKey, ballCup]); // eslint-disable-line react-hooks/exhaustive-deps

  const ballSlot = ballCup !== null ? positions.indexOf(ballCup) : -1;
  const chosenSlot = positions.indexOf(chosenCup);
  // Only lock the cups while THIS round is animating. After complete() the
  // pick is cleared (GamePage defaultChoices) but `revealed` used to stay
  // true — cups stayed disabled, the CTA said "Tap a cup", and the only way
  // out was a reload.
  const cupsLocked = shuffling || flow.playing;

  const pickCup = (slot: number) => {
    if (cupsLocked) return;
    sound.play('bet_place');
    if (revealed) {
      // Drop the previous reveal so the table is a fresh pick, not three
      // lifted cups from last round.
      setRevealedRound(0);
      setBallOut(false);
      setPositions([0, 1, 2]);
      setChoices({ cup: slot });
      return;
    }
    setChoices({ ...choices, cup: positions[slot] });
  };

  return (
    <GameBackdrop accent={GOLD}>
      {/* D-101: scroll-safe wrapper */}
      <div className="relative w-full h-full overflow-y-auto">
        <div
          className="min-h-full w-full flex flex-col items-center justify-center gap-4 px-4 py-2"
          style={{
            background: 'radial-gradient(circle at 50% 55%, #2a1a0c 0%, #120a05 75%)',
          }}
        >
          <p className="t-label-md text-white/50 tracking-wide">
            {shuffling
              ? 'Shuffling…'
              : revealed
                ? win
                  ? 'FOUND IT! ✓'
                  : 'Not your cup this time…'
                : hasPick
                  ? `Cup ${chosenCup + 1} it is — hit TAKE THE CUP`
                  : 'Tap the cup you think hides the ball'}
          </p>

          {/* table */}
          <div
            className="relative w-[min(92vw,420px)] rounded-3xl border border-gold/15 py-10 px-6"
            style={{
              background:
                'linear-gradient(180deg, rgba(58,38,18,0.5), rgba(20,12,5,0.8))',
              boxShadow: 'inset 0 0 50px rgba(0,0,0,0.6)',
            }}
          >
            {/* ball before shuffle */}
            {!cupsLocked && !revealed && (
              <div className="absolute left-1/2 top-2 -translate-x-1/2 text-3xl animate-bounce">
                🟡
              </div>
            )}
            <div className="flex gap-10 justify-center items-end">
              {[0, 1, 2].map((slot) => {
                const isBallSlot = revealed && slot === ballSlot;
                const isChosen = slot === chosenSlot;
                const lifted = isBallSlot;
                return (
                  <div key={slot} className="flex flex-col items-center relative">
                    {/* ball under the revealed cup */}
                    {isBallSlot && ballOut && (
                      <div className="absolute -top-10 left-1/2 -translate-x-1/2 text-3xl animate-ball-pop drop-shadow-[0_0_10px_rgba(245,200,66,0.8)] z-10">
                        🟡
                      </div>
                    )}
                    {revealed && !isBallSlot && (
                      <div className="absolute -top-9 left-1/2 -translate-x-1/2 t-label-sm text-white/40 whitespace-nowrap z-10">
                        empty
                      </div>
                    )}
                    {/* THE CUP IS THE CONTROL. It used to be `disabled` and the
                      pick was made from a "Cup 1 / Cup 2 / Cup 3" list inside
                      the bet popup — you never touched a cup. */}
                    <button
                      disabled={cupsLocked}
                      aria-label={`Pick cup ${positions[slot]! + 1}`}
                      aria-pressed={isChosen}
                      onClick={() => pickCup(slot)}
                      className={`text-6xl sm:text-7xl drop-shadow-[0_12px_18px_rgba(0,0,0,0.7)] transition-all duration-300 disabled:cursor-default ${lifted ? '-translate-y-12 scale-105' : ''} ${shuffling ? 'animate-cup-shuffle' : ''} ${!cupsLocked ? 'hover:-translate-y-2 active:scale-90 cursor-pointer' : ''} ${!cupsLocked && !isChosen ? 'opacity-80' : ''}`}
                      style={{ transitionDelay: shuffling ? '0ms' : `${slot * 40}ms` }}
                    >
                      {shuffling ? '🧿' : '🥤'}
                    </button>
                    {/* your cup ring */}
                    {isChosen && hasPick && (
                      <span
                        className="absolute top-2 left-1/2 -translate-x-1/2 w-16 h-16 rounded-full border-2 pointer-events-none"
                        style={{
                          borderColor: revealed
                            ? win
                              ? GREEN
                              : 'rgba(255,255,255,0.35)'
                            : GOLD,
                          boxShadow:
                            revealed && win
                              ? `0 0 16px ${GREEN}66`
                              : `0 0 12px ${GOLD}44`,
                          transition: 'all .3s',
                        }}
                      />
                    )}
                    <span
                      className={`mt-3 t-label-sm ${isChosen && hasPick ? 'text-gold font-bold' : 'text-white/40'}`}
                    >
                      {/* Label rides WITH the cup through the shuffle — after a
                        shuffle the physical cup now at this slot keeps its own
                        number, so "Ball was under Cup N", the ball glyph, the
                        chosen-cup ring and the pick prompt always agree. (It
                        used to be slot+1, which contradicted the reveal text
                        whenever the shuffle moved the ball's cup.) */}
                      Cup {positions[slot]! + 1}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* result */}
          {revealed && (
            <Glass className="px-6 py-2 animate-spring-in" glow={win ? GREEN : RED}>
              <span
                className={`t-headline font-black tracking-widest ${win ? 'text-green' : 'text-white/60'}`}
              >
                {win ? 'FOUND IT! ✓' : `Ball was under Cup ${ballCup! + 1}`}
              </span>
            </Glass>
          )}

          <ResultBanner
            ready={flow.revealed}
            roundKey={flow.roundKey}
            result={result}
            multiplier={(outcome as { multiplier?: number })?.multiplier}
            payout={(outcome as { payout?: number })?.payout}
          />
          <style>{`
          @keyframes wiggle { 0%,100% { transform: rotate(-3deg) } 50% { transform: rotate(3deg) } }
          .animate-cup-shuffle { animation: wiggle .26s ease-in-out infinite }
          @keyframes ballPop { 0% { transform: translate(-50%, 14px) scale(0.4); opacity: 0 } 50% { transform: translate(-50%, -16px) scale(1.2); opacity: 1 } 70% { transform: translate(-50%, -8px) scale(0.95) } 100% { transform: translate(-50%, 0) scale(1) } }
          .animate-ball-pop { animation: ballPop 0.6s cubic-bezier(0.2,0.9,0.3,1.3) forwards }
        `}</style>
        </div>
      </div>
    </GameBackdrop>
  );
}

export function ThimblesBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  const picked = choices.cup !== undefined && choices.cup !== null;
  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel={picked ? `TAKE CUP ${Number(choices.cup) + 1}` : 'TAKE THE CUP'}
      selection={
        picked ? `Cup ${Number(choices.cup) + 1} · find the ball to win` : null
      }
      requirement={picked ? null : 'Tap a cup to pick it'}
      multiplier={2.88}
    />
  );
}
