// apps/web/src/components/games/individual/TowerGame.tsx — REAL tower (D-092):
// ONE bet per round → climb 10 floors → pick a tile per floor → multiplier grows
// → CASH OUT anytime or fall. Server decides every floor's trap positions.
//
// Multipliers on the board come from the same resolver the engine uses
// (`resolveTowerBoard`) so a panel edit of per-floor × is what players see.
'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { BetBar } from '../../BetBar';
import {
  GameBackdrop,
  ResultBanner,
  ActionTile,
  Glass,
  CountUp,
  GOLD,
  GREEN,
  RED,
  VIOLET,
} from '../game-kit';
import { sound } from '../../../lib/sound';
import { vibrate } from '../../../hooks';
import type { GameVisualProps, GameBetPanelProps } from '../types';
import {
  TOWER_FLOORS,
  TOWER_DIFFICULTY_IDS,
  DEFAULT_TOWER_DIFFS,
  resolveTowerBoard,
} from '@casino/shared';

function formatMult(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

export function TowerVisual({
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
  const difficulty = String(
    session?.extra?.difficulty ?? choices.difficulty ?? 'medium'
  );
  const board = useMemo(
    () => resolveTowerBoard(config.configJson, difficulty),
    [config.configJson, difficulty]
  );
  // Mid-round: trust the session snapshot so an admin save cannot reshape
  // the live grid under the player's finger.
  const cols = Number(session?.extra?.cols ?? board.cols);
  const ladder = board.ladder;
  // Stable identity across renders (see MinesGame): the bare `?? []` allocated
  // a new array each render, defeating the memos that depend on it.
  const steps = useMemo(
    () =>
      (session?.steps ?? []) as Array<{
        floor?: number;
        column?: number;
        safe?: boolean;
        floorReached?: number;
      }>,
    [session?.steps]
  );
  const active = session?.status === 'ACTIVE';
  const floor = Number(session?.extra?.floor ?? 0); // next floor to climb (0-based)
  const path = useMemo(() => new Map(steps.map((s) => [s.floor, s.column!])), [steps]);
  const safePath = useMemo(
    () => new Map(steps.filter((s) => s.safe).map((s) => [s.floor, s.column!])),
    [steps]
  );
  const lost = result === 'LOSE';
  const lostFloor = lost ? ((outcome as { floor?: number })?.floor ?? floor - 1) : -1;
  const trapPos = lost
    ? ((outcome as { trapPositions?: number[] }).trapPositions ?? [])
    : [];
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

  const pick = (col: number) => {
    if (!active || sessionBusy) return;
    vibrate(10);
    void onSessionStep?.({ column: col });
  };

  return (
    // fit=false: 10 flex-shrinking floors fill the canvas. FitToCanvas would
    // scale the whole board down to ~0.5 on a phone and make the tiles
    // unhittable (the original "not mobile responsive" report).
    <GameBackdrop accent={VIOLET} fit={false}>
      <div
        className={`relative w-full h-full min-h-0 flex flex-col px-2 sm:px-3 py-1 sm:py-2 gap-1 ${falling ? 'animate-tower-fall' : ''}`}
      >
        {/* ladder / tower — flex-1 so each floor shrinks to the leftover height */}
        <div className="flex-1 min-h-0 flex flex-col-reverse gap-[3px] sm:gap-1 w-full max-w-md mx-auto">
          {Array.from({ length: TOWER_FLOORS }).map((_, f) => {
            const isCurrent = active && f === floor;
            const climbed = safePath.has(f);
            const fellHere = lostFloor === f;
            return (
              // The row you are standing on must never be dimmed — it is the one you
              // have to tap. Previously every un-climbed floor got opacity-30,
              // including the active one, so the board looked switched off and
              // there was no visible cue where to press.
              <div
                key={f}
                className={`flex gap-1 sm:gap-1.5 items-stretch min-h-[26px] max-h-[44px] flex-1 transition-opacity ${climbed || fellHere || f < floor || isCurrent ? '' : 'opacity-25'}`}
              >
                <span className="t-label-sm text-muted w-4 sm:w-6 text-right shrink-0 self-center tabular-nums text-[10px] sm:text-[11px]">
                  {f + 1}
                </span>
                <div
                  className="flex-1 grid gap-1 sm:gap-1.5 min-w-0"
                  style={{ gridTemplateColumns: `repeat(${cols},1fr)` }}
                >
                  {Array.from({ length: cols }).map((_, c) => {
                    const climbedHere = path.get(f) === c && safePath.has(f);
                    const fellHereTile = fellHere && trapPos.includes(c);
                    const state = fellHereTile
                      ? 'mine'
                      : climbedHere
                        ? 'safe'
                        : isCurrent
                          ? 'active'
                          : climbed || fellHere
                            ? 'faded'
                            : 'idle';
                    return (
                      <ActionTile
                        key={c}
                        state={state}
                        disabled={!active || sessionBusy || !isCurrent}
                        onClick={() => isCurrent && pick(c)}
                        className={`h-full min-h-[26px] ${isCurrent ? 'ring-1 ring-gold/60 shadow-[0_0_12px_rgba(245,200,66,0.25)] animate-pulse-tile' : ''}`}
                      >
                        {climbedHere ? (
                          <span className="text-green text-sm sm:text-lg animate-spring-in">
                            ✓
                          </span>
                        ) : fellHereTile ? (
                          <span className="text-red text-sm sm:text-lg animate-bomb-burst">
                            ✕
                          </span>
                        ) : isCurrent ? (
                          <span className="text-gold/70 text-xs sm:text-sm">▲</span>
                        ) : null}
                      </ActionTile>
                    );
                  })}
                </div>
                <span
                  className="t-label-sm w-10 sm:w-12 text-right shrink-0 self-center tabular-nums text-[10px] sm:text-[12px]"
                  style={{
                    color:
                      climbed || fellHere
                        ? fellHere
                          ? RED
                          : GOLD
                        : 'rgba(255,255,255,0.25)',
                  }}
                >
                  {formatMult(ladder[f] ?? 0)}×
                </span>
              </div>
            );
          })}
        </div>

        {active && (
          <p className="hidden sm:block t-label-sm text-gold/80 tracking-wide text-center shrink-0">
            ↑ Tap a tile on the glowing floor
          </p>
        )}
        <style>{`@keyframes pulseTile{0%,100%{box-shadow:0 0 10px rgba(245,200,66,0.20)}50%{box-shadow:0 0 18px rgba(245,200,66,0.45)}}.animate-pulse-tile{animation:pulseTile 1.5s ease-in-out infinite}`}</style>

        {/* status */}
        <Glass className="w-full max-w-md mx-auto px-3 py-1.5 sm:px-4 sm:py-2 flex justify-between items-center shrink-0">
          <span className="t-label-sm text-secondary">
            Floor {Math.min(floor + 1, TOWER_FLOORS)}/{TOWER_FLOORS}
          </span>
          {active ? (
            <span
              className="t-num-lg"
              style={{ color: GOLD, textShadow: `0 0 20px ${GOLD}55` }}
            >
              <CountUp value={session!.currentMultiplier} decimals={2} duration={400} />
              ×
            </span>
          ) : (
            <span
              className={`t-num-md ${lost ? 'text-red' : session ? 'text-green' : 'text-white/40'}`}
            >
              {lost ? 'FELL!' : session ? 'CASHED OUT ✓' : 'Place a bet to climb'}
            </span>
          )}
        </Glass>
        {active && session && (
          <p className="t-label-sm text-muted -mt-0.5 text-center shrink-0">
            next floor pays {formatMult(session.nextMultiplier)}×
          </p>
        )}

        {/* DIFFICULTY — chosen on the board before the climb starts. First-floor
            × is the live admin ladder, not a hardcoded fair chip. */}
        {!session && (
          <div className="w-full max-w-md mx-auto shrink-0">
            <div className="grid grid-cols-4 gap-1 sm:gap-1.5">
              {TOWER_DIFFICULTY_IDS.map((id) => {
                const d = resolveTowerBoard(config.configJson, id);
                const grid = `${d.cols}×${d.traps}`;
                const pay = `${formatMult(d.ladder[0] ?? 0)}×`;
                const selected = String(choices.difficulty ?? 'medium') === id;
                return (
                  <button
                    key={id}
                    onClick={() => setChoices({ ...choices, difficulty: id })}
                    className={`py-1 sm:py-1.5 rounded-lg flex flex-col items-center transition-all ${selected ? 'bg-gold/15 border border-gold/40' : 'bg-white/5 border border-white/8 active:scale-95'}`}
                  >
                    <span
                      className={`text-[10px] sm:text-[11px] font-bold ${selected ? 'text-gold' : 'text-white/65'}`}
                    >
                      {id.toUpperCase()}
                    </span>
                    <span className="text-[9px] sm:text-[10px] text-white/35 leading-none">
                      {grid} · {pay}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/*
          Fall overlay.

          This used to print "GAME OVER" dead centre while the shared
          <ResultBanner> printed "YOU LOSE" in the SAME place, so the two texts
          rendered on top of each other and neither was readable. The banner
          says what happened; this overlay only offers the way back in, parked
          below the centre line so they never collide.
        */}
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
    </GameBackdrop>
  );
}

export function TowerBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  // Difficulty moved onto the board, above the tower it describes.
  const d = String(choices.difficulty ?? 'medium');
  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel={`START CLIMB — ${d.toUpperCase()}`}
      selection={`${d.toUpperCase()} tower · each floor multiplies your stake`}
    />
  );
}
