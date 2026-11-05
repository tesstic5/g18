// apps/web/src/components/games/individual/MinesGame.tsx — REAL mines (D-092):
// ONE bet per round → 5×5 board → dig tiles → multiplier grows → CASH OUT anytime
// (payout = bet × multiplier) or hit a 💣. Server drives every reveal; the board
// animates exactly what the server returned.
'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { BetBar } from '../../BetBar';
import { Segment } from '../types';
import {
  GameBackdrop,
  ResultBanner,
  ActionTile,
  CountUp,
  GOLD,
  GREEN,
} from '../game-kit';
import { sound } from '../../../lib/sound';
import { vibrate } from '../../../hooks';
import type { GameVisualProps, GameBetPanelProps } from '../types';
import { PickPrompt } from '../board-kit';

const GRID = 25;

export function MinesVisual({
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
  const [shaking, setShaking] = useState(false);
  const [revealing, setRevealing] = useState<number | null>(null); // tile currently flipping
  const [boardIn, setBoardIn] = useState(false);

  // ── derive board state from the server session (source of truth) ─────────
  // Memoized so the identity is stable across renders — `session?.steps ?? []`
  // allocated a NEW array every render, which made the useMemo below recompute
  // every time (i.e. it wasn't memoizing anything).
  const steps = useMemo(
    () =>
      (session?.steps ?? []) as Array<{
        tile?: number;
        safe?: boolean;
        isMine?: boolean;
        minePositions?: number[];
        currentMultiplier?: number;
      }>,
    [session?.steps]
  );
  const revealedSafe = useMemo(
    () => new Set(steps.filter((s) => s.safe).map((s) => s.tile)),
    [steps]
  );
  const bustStep = outcome as {
    isMine?: boolean;
    minePositions?: number[];
    tile?: number;
  } | null;
  const bustedTile = result === 'LOSE' ? (bustStep?.tile ?? null) : null;
  const bustMines: number[] = result === 'LOSE' ? (bustStep?.minePositions ?? []) : [];
  const mineCount = Number(session?.extra?.mineCount ?? choices.mineCount ?? 3);
  const active = session?.status === 'ACTIVE';

  // board entrance
  useEffect(() => {
    if (session) {
      const t = setTimeout(() => setBoardIn(true), 50);
      return () => clearTimeout(t);
    }
    setBoardIn(false);
  }, [session?.roundId]); // eslint-disable-line react-hooks/exhaustive-deps

  // animate the newest reveal: flip → pop
  const lastStep = steps[steps.length - 1];
  useEffect(() => {
    if (lastStep?.tile === undefined || lastStep.tile === null) return;
    setRevealing(lastStep.tile);
    const t = setTimeout(() => setRevealing(null), 420);
    return () => clearTimeout(t);
  }, [lastStep?.tile, lastStep?.safe]);

  // bust: shake + explosion
  useEffect(() => {
    if (result !== 'LOSE' || bustedTile === null) return;
    setShaking(true);
    sound.play('mine_explode');
    const t = setTimeout(() => setShaking(false), 700);
    return () => clearTimeout(t);
  }, [result, bustedTile]);

  const clickTile = (i: number) => {
    if (!active || sessionBusy || revealing !== null) return;
    if (revealedSafe.has(i)) return;
    vibrate(15);
    void onSessionStep?.({ tile: i });
  };

  const safeCount = revealedSafe.size;
  const isRevealed = (i: number) =>
    revealedSafe.has(i) ||
    (result === 'LOSE' && (bustMines.includes(i) || bustedTile === i));
  const isMine = (i: number) => result === 'LOSE' && bustMines.includes(i);

  return (
    <GameBackdrop accent={GOLD}>
      {/* D-096: outer scroll container (min-h-full centers when short, scrolls
          from the top when the board exceeds the canvas on small phones) */}
      <div className="relative w-full h-full overflow-y-auto">
        <div className="min-h-full w-full flex flex-col items-center justify-center gap-1.5 px-4 py-1.5">
          <PickPrompt show={!session}>
            Change how many mines are hidden before you start
          </PickPrompt>
          {/* multiplier bar — compact single row (D-096) */}
          <div className="flex items-center gap-2">
            <span
              className="px-2.5 py-0.5 rounded-full border text-center"
              style={{ borderColor: `${GOLD}44`, background: `${GOLD}12` }}
            >
              <span
                className="t-label-sm uppercase tracking-widest"
                style={{ color: `${GOLD}bb` }}
              >
                Current{' '}
              </span>
              <span className="t-num-md tabular-nums" style={{ color: GOLD }}>
                {active ? session!.currentMultiplier.toFixed(2) : '1.00'}×
              </span>
            </span>
            {active && (
              <span
                className="px-2.5 py-0.5 rounded-full border text-center"
                style={{ borderColor: `${GREEN}44`, background: `${GREEN}12` }}
              >
                <span
                  className="t-label-sm uppercase tracking-widest"
                  style={{ color: `${GREEN}bb` }}
                >
                  Next{' '}
                </span>
                <span className="t-num-md tabular-nums" style={{ color: GREEN }}>
                  {session!.nextMultiplier.toFixed(2)}×
                </span>
              </span>
            )}
            <span className="px-2 py-0.5 rounded-full border border-white/10 bg-white/[0.04]">
              <span className="t-label-sm text-white/70">
                💣 {mineCount} · {GRID - mineCount} safe
              </span>
            </span>
          </div>

          {/* board — dvh-clamped so it always fits the canvas height (D-096) */}
          <div
            className={`grid grid-cols-5 gap-1.5 sm:gap-2 w-[min(84vw,320px,32dvh)] ${shaking ? 'animate-board-shake' : ''}`}
          >
            {Array.from({ length: GRID }).map((_, i) => {
              const revealed = isRevealed(i);
              const mine = isMine(i);
              const justRevealed =
                revealing === i || (result === 'LOSE' && bustedTile === i);
              const state =
                !active && !revealed
                  ? 'faded'
                  : mine
                    ? 'mine'
                    : revealed
                      ? 'safe'
                      : bustedTile !== null
                        ? 'faded'
                        : 'idle';
              return (
                <ActionTile
                  key={i}
                  state={state}
                  disabled={!active || sessionBusy || revealing !== null}
                  onClick={() => clickTile(i)}
                  className="aspect-square transition-all duration-300"
                  // staggered board entrance
                >
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                    style={{
                      animationDelay: `${boardIn ? i * 18 : 0}ms`,
                      opacity: boardIn ? 1 : 0,
                      transition: 'opacity .3s',
                    }}
                  >
                    {revealed && !mine && (
                      <span className="text-2xl sm:text-3xl animate-spring-in drop-shadow-[0_0_12px_rgba(0,217,126,0.7)]">
                        💎
                      </span>
                    )}
                    {revealed && mine && bustedTile !== i && (
                      <span className="text-2xl sm:text-3xl opacity-70">💣</span>
                    )}
                    {bustedTile === i && (
                      <span className="text-3xl sm:text-4xl animate-bomb-burst">
                        💥
                      </span>
                    )}
                    {!revealed && !bustedTile && (
                      <span
                        className={`w-6 h-6 rounded-md border border-white/10 ${justRevealed ? 'animate-tile-flip' : ''} ${active ? 'bg-white/[0.03] group-hover:bg-gold/10' : 'bg-white/[0.02]'}`}
                      />
                    )}
                  </div>
                </ActionTile>
              );
            })}
          </div>

          {/* HOW MANY MINES — the core risk decision, made on the board next to
            the grid it changes. It used to live in the bet popup. Locked once a
            round is running (the grid is already committed). */}
          {!session && (
            <div className="w-full max-w-[300px]">
              <div className="flex items-center justify-between mb-1">
                <span className="t-label-sm text-white/50">Mines</span>
                <span className="t-label-sm text-gold font-bold">
                  {Number(choices.mineCount ?? 3)} · first dig pays{' '}
                  {minesFirstPayout(Number(choices.mineCount ?? 3)).toFixed(2)}×
                </span>
              </div>
              <div className="grid grid-cols-6 gap-1.5">
                {[1, 3, 5, 10, 15, 24].map((m) => (
                  <button
                    key={m}
                    onClick={() => setChoices({ ...choices, mineCount: m })}
                    className={`h-9 rounded-lg t-num-md transition-all ${Number(choices.mineCount ?? 3) === m ? 'bg-gold/15 border border-gold/40 text-gold' : 'bg-white/5 border border-white/8 text-white/60 active:scale-95'}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* status — compact line (D-096) */}
          <div className="px-3 py-1 rounded-full border border-white/10 bg-white/[0.04] text-center">
            {!session ? (
              <span className="t-label-sm text-white/50">
                Place your bet, then tap tiles to dig — cash out any time
              </span>
            ) : result === 'LOSE' ? (
              <span className="t-headline text-red">BOOM! Hit a mine 💣</span>
            ) : active ? (
              <span className="t-label-sm text-white/80">
                <CountUp
                  value={session!.currentMultiplier}
                  decimals={2}
                  duration={400}
                />
                × · {safeCount} safe tile{safeCount === 1 ? '' : 's'} dug
                {session!.currentMultiplier >= 1.5 ? ' · nice! 🎯' : ''}
              </span>
            ) : (
              <span className="t-headline text-green">CASHED OUT ✓</span>
            )}
          </div>

          {/* bust overlay — mines revealed + play again */}
          {result === 'LOSE' && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 pointer-events-auto backdrop-blur-[2px]">
              <button
                onClick={() => {
                  onSessionReset?.();
                }}
                className="btn-primary px-7 h-12 rounded-xl shadow-[0_4px_24px_rgba(255,59,92,0.4)]"
              >
                💣 Hit a mine — <b>PLAY AGAIN</b>
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
          @keyframes boardShake { 0%,100% { transform: translate(0,0) } 20% { transform: translate(-6px,3px) } 40% { transform: translate(5px,-4px) } 60% { transform: translate(-4px,-2px) } 80% { transform: translate(3px,2px) } }
          .animate-board-shake { animation: boardShake 0.5s ease-in-out }
          @keyframes bombBurst { 0% { transform: scale(0.2); opacity: 0 } 40% { transform: scale(1.5); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
          .animate-bomb-burst { animation: bombBurst 0.5s cubic-bezier(0.2,0.9,0.3,1.4) forwards }
          @keyframes tileFlip { 0% { transform: rotateY(0deg) scale(1) } 50% { transform: rotateY(90deg) scale(1.15) } 100% { transform: rotateY(0deg) scale(1) } }
          .animate-tile-flip { animation: tileFlip 0.4s ease-in-out }
        `}</style>
        </div>
      </div>
    </GameBackdrop>
  );
}

/** Fair payout after the first safe dig — mirrors minesLadder() on the server. */
export function minesFirstPayout(mines: number): number {
  const m = Math.min(24, Math.max(1, mines));
  return +(0.96 * (25 / (25 - m))).toFixed(2);
}

export function MinesBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  // Mine count moved onto the board, beside the grid it describes.
  const m = Number(choices.mineCount ?? 3);
  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel={`START \u2014 ${m} MINE${m === 1 ? '' : 'S'}`}
      selection={`${m} mine${m === 1 ? '' : 's'} hidden · dig safe tiles, cash out any time`}
    />
  );
}
