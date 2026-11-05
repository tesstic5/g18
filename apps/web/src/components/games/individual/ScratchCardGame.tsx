// apps/web/src/components/games/individual/ScratchCardGame.tsx — gold scratch card (D-069)
'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BetBar } from '../../BetBar';
import { GameBackdrop, ResultBanner, Glass, GOLD, GREEN, RED } from '../game-kit';
import { useRoundFlow, flowFallbackMs } from '../useRoundFlow';
import { sound } from '../../../lib/sound';
import { PickPrompt } from '../board-kit';
import type { GameVisualProps, GameBetPanelProps } from '../types';

export function ScratchCardVisual({
  outcome,
  result,
  choices,
  setChoices,
  onRoundComplete,
}: GameVisualProps) {
  // The scratching IS the animation — completion only happens when the player
  // has uncovered enough of the foil (finishScratch) or taps "Reveal all".
  // flow provides the round identity and a dead-man fallback, nothing more.
  const flow = useRoundFlow(outcome, flowFallbackMs('scratch-card'));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scratched, setScratched] = useState(0);
  /** the round whose card is revealed — tagged so round N's reveal can never
   * paint round N+1's fresh card as already-open */
  const [revealedRound, setRevealedRound] = useState(0);
  // Stable identity: the bare `?? []` allocated a new array every render, so
  // the useMemo depending on it recomputed continuously.
  //
  // Read from flow.outcome (the sticky round snapshot), not the raw prop: the
  // page parks the prop at null while the next bet is in flight.
  const liveOutcome = flow.outcome;
  const grid = useMemo(
    () => (liveOutcome as { grid?: string[] } | null)?.grid ?? [],
    [liveOutcome]
  );
  const winLine =
    (liveOutcome as { winLine?: string[] | null } | null)?.winLine ?? null;
  const win = result === 'WIN';
  const revealed = revealedRound === flow.roundKey && flow.roundKey > 0;
  const cardPick =
    choices.card === undefined || choices.card === null ? null : Number(choices.card);
  // D-095: find the winning cells (row/col/diag) to highlight at reveal
  const winCells = React.useMemo(() => {
    if (!win || !winLine?.length) return [] as number[];
    const sym = winLine[0];
    const lines: number[][] = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8], // rows
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8], // cols
      [0, 4, 8],
      [2, 4, 6], // diagonals
    ];
    for (const line of lines) if (line.every((i) => grid[i] === sym)) return line;
    return [];
  }, [win, winLine, grid]);

  // Draw a FRESH foil once per round. Keyed on roundKey (not just the grid
  // contents): a back-to-back identical card is still a new card, and a board
  // that only watched `grid` left round 1's scratched-open foil over round 2's
  // fresh symbols — the card arrived pre-revealed.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || grid.length === 0) return;
    setScratched(0);
    const ctx = cv.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = cv.clientWidth * dpr;
    cv.height = cv.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    // gold foil
    const g = ctx.createLinearGradient(0, 0, cv.clientWidth, cv.clientHeight);
    g.addColorStop(0, '#e8c252');
    g.addColorStop(0.5, '#c9a227');
    g.addColorStop(1, '#a8821d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);
    // shine lines
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    for (let i = -cv.clientHeight; i < cv.clientWidth; i += 26) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + cv.clientHeight, cv.clientHeight);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(60,40,0,0.55)';
    ctx.font = '900 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      '✨ SCRATCH TO REVEAL ✨',
      cv.clientWidth / 2,
      cv.clientHeight / 2 + 7
    );

    let uncovered = 0;
    let last = { x: 0, y: 0 };
    // D-095: sparkle trail — gold particles drawn UNDER the foil as you scratch
    const sparkles: Array<{ x: number; y: number; life: number }> = [];
    const erase = (x: number, y: number) => {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(x, y, 15, 0, Math.PI * 2);
      ctx.fill();
      // sparkle bursts along the scratch path
      for (let i = 0; i < 5; i++)
        sparkles.push({
          x: x + (Math.random() - 0.5) * 24,
          y: y + (Math.random() - 0.5) * 24,
          life: 14,
        });
      uncovered++;
      if (uncovered % 3 === 0) setScratched((s) => Math.min(100, s + 2));
    };
    const paintSparkles = () => {
      ctx.globalCompositeOperation = 'source-over';
      const alive: typeof sparkles = [];
      for (const s of sparkles) {
        s.life--;
        if (s.life > 0) {
          ctx.globalAlpha = Math.max(0, s.life / 14) * 0.9;
          ctx.fillStyle = '#ffe066';
          ctx.beginPath();
          ctx.arc(s.x, s.y, 2.2, 0, Math.PI * 2);
          ctx.fill();
          alive.push(s);
        }
      }
      ctx.globalAlpha = 1;
      if (alive.length) {
        sparkles.length = 0;
        sparkles.push(...alive);
        requestAnimationFrame(paintSparkles);
      }
    };
    let pointerDown = false;
    let completed = false;
    const onPointer = (e: PointerEvent) => {
      if (!pointerDown) return;
      const r = cv.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * cv.clientWidth;
      const y = ((e.clientY - r.top) / r.height) * cv.clientHeight;
      // line between last and current for a smooth scratch
      const dist = Math.hypot(x - last.x, y - last.y);
      const steps = Math.max(1, Math.floor(dist / 6));
      for (let i = 1; i <= steps; i++)
        erase(last.x + ((x - last.x) * i) / steps, last.y + ((y - last.y) * i) / steps);
      last = { x, y };
      if (sparkles.length === 1) requestAnimationFrame(paintSparkles);
    };
    const onDown = (e: PointerEvent) => {
      // touch-action:none on the element + preventDefault here keeps Chrome
      // from classifying the drag as page scroll — without BOTH, every mobile
      // scratch dies after the first move (pointercancel), which is why the
      // foil "does not remove" on phones while desktop mice scratch fine.
      e.preventDefault();
      pointerDown = true;
      cv.setPointerCapture(e.pointerId);
      const r = cv.getBoundingClientRect();
      last = {
        x: ((e.clientX - r.left) / r.width) * cv.clientWidth,
        y: ((e.clientY - r.top) / r.height) * cv.clientHeight,
      };
      sound.play('coin_flip');
    };
    const finishScratch = (e?: PointerEvent) => {
      pointerDown = false;
      if (e && cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      if (uncovered > 28 && !completed) {
        completed = true;
        setRevealedRound(flow.roundKey);
        flow.complete();
        sound.play(win ? 'win' : 'lose');
        onRoundComplete?.();
      }
    };
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onPointer);
    cv.addEventListener('pointerup', finishScratch);
    cv.addEventListener('pointercancel', finishScratch);
    return () => {
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onPointer);
      cv.removeEventListener('pointerup', finishScratch);
      cv.removeEventListener('pointercancel', finishScratch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- win tracks 1:1 with the round; roundKey+grid are the real keys
  }, [flow.roundKey, grid, win]);

  return (
    <GameBackdrop accent={GOLD}>
      {/* D-096: scroll-safe wrapper */}
      <div className="relative w-full h-full overflow-y-auto">
        <div className="min-h-full w-full flex flex-col items-center justify-center gap-2 px-4 py-1.5">
          {/* PICK YOUR CARD. The game had no decision at all before: you tapped
            PLAY and were handed a card. Superstition is half the appeal of a
            scratch card, so let the player choose which one they want. The odds
            are identical for every card — this is a choice of feel, not value,
            and the label says so. */}
          {/* The picker must return when a card is FINISHED, not only before the
            first card: gating on !outcome alone left round 1's settled outcome in
            the state forever, so round 2+ showed the old revealed card with no
            way to pick again (reload was the only way back). `revealed` marks a
            completed round — the board resets to the picker from there until the
            next bet lands (which flips both outcomes again). */}
          {(!outcome || revealed) && (
            <>
              <PickPrompt show={cardPick === null}>Choose your card</PickPrompt>
              <div className="grid grid-cols-3 gap-2 w-[min(76vw,270px)]">
                {[0, 1, 2].map((i) => (
                  <button
                    key={i}
                    onClick={() => {
                      sound.play('bet_place');
                      setChoices({ ...choices, card: i });
                    }}
                    aria-pressed={cardPick === i}
                    className={`aspect-[3/4] rounded-xl border-2 flex flex-col items-center justify-center gap-1 transition-all active:scale-95 ${
                      cardPick === i
                        ? 'border-gold bg-gold/15 shadow-[0_0_18px_rgba(245,200,66,0.4)] scale-[1.03]'
                        : 'border-white/12 bg-white/[0.04]'
                    }`}
                  >
                    <span className="text-2xl">{['🎟️', '🎫', '🪙'][i]}</span>
                    <span
                      className={`t-label-sm font-bold ${cardPick === i ? 'text-gold' : 'text-white/50'}`}
                    >
                      Card {i + 1}
                    </span>
                  </button>
                ))}
              </div>
              <p className="t-label-sm text-white/30">
                Every card has the same odds — pick your lucky one
              </p>
            </>
          )}
          {outcome && !revealed && (
            <p className="t-label-sm text-white/50">
              Scratch the foil to reveal your card
            </p>
          )}
          {outcome && !revealed && (
            <div className="relative w-[min(76vw,270px,34dvh)] aspect-square">
              {/* symbols underneath */}
              <div
                className="absolute inset-0 grid grid-cols-3 grid-rows-3 gap-1.5 rounded-2xl p-2"
                style={{
                  background: 'linear-gradient(160deg, #1c1c30, #10101f)',
                  boxShadow: 'inset 0 0 30px rgba(0,0,0,0.7)',
                }}
              >
                {grid.map((s, i) => {
                  const isWinCell = revealed && winCells.includes(i);
                  return (
                    <div
                      key={i}
                      className={`rounded-lg flex items-center justify-center text-3xl animate-spring-in ${isWinCell ? 'bg-green/15 ring-2 ring-green shadow-[0_0_16px_rgba(0,217,126,0.5)] scale-105 z-10' : 'bg-white/[0.04]'}`}
                      style={{ animationDelay: `${i * 40}ms` }}
                    >
                      {s}
                    </div>
                  );
                })}
              </div>
              {/* scratch overlay */}
              <canvas
                ref={canvasRef}
                style={{ touchAction: 'none' }}
                className="absolute inset-0 w-full h-full rounded-2xl cursor-pointer shadow-[0_12px_36px_rgba(0,0,0,0.5)]"
              />
              {/* frame */}
              <div className="absolute inset-0 rounded-2xl border-2 border-gold/40 pointer-events-none" />
            </div>
          )}
          {outcome && !revealed && (
            <div className="flex items-center gap-3">
              <div className="w-24 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${scratched}%`,
                    background: `linear-gradient(90deg, ${GOLD}, #fff)`,
                  }}
                />
              </div>
              <span className="t-label-sm text-white/60">{scratched}%</span>
              {/* The round is already settled server-side the moment the card is
              bought. The scratching is how the PLAYER discovers it — so until
              they scratch, the result stays hidden. This is the escape hatch
              for anyone who would rather just see it. */}
              {grid.length > 0 && !revealed && (
                <button
                  onClick={() => {
                    // The escape hatch completes the round exactly like a real
                    // scratch-through does — it used to skip onRoundComplete, so
                    // the page's state machine never learned the round ended.
                    setRevealedRound(flow.roundKey);
                    flow.complete();
                    sound.play(win ? 'win' : 'lose');
                    onRoundComplete?.();
                  }}
                  className="h-7 px-3 rounded-full bg-white/5 border border-white/10 t-label-sm text-white/60 active:scale-95"
                >
                  Reveal all
                </button>
              )}
            </div>
          )}
          {revealed && (
            <Glass className="px-6 py-2 animate-spring-in" glow={win ? GREEN : RED}>
              <span
                className={`t-headline font-black ${win ? 'text-green' : 'text-white/50'}`}
              >
                {win ? `WIN — ${winLine?.[0]} LINE! ✓` : 'No luck this time'}
              </span>
              {win && (
                <span className="block t-num-md text-gold mt-0.5">
                  +{process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
                  {((outcome as { payout?: number })?.payout ?? 0).toLocaleString()}
                </span>
              )}
            </Glass>
          )}
          <ResultBanner
            ready={revealed}
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
    </GameBackdrop>
  );
}

export function ScratchCardBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  const picked = choices.card !== undefined && choices.card !== null;
  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel={picked ? `BUY CARD ${Number(choices.card) + 1}` : 'BUY A CARD'}
      selection={picked ? `Card ${Number(choices.card) + 1} · scratch to reveal` : null}
      requirement={picked ? null : 'Choose a card first'}
    />
  );
}
