// apps/web/src/components/games/individual/PlinkoGame.tsx — real Galton-board plinko.
//
// The server now walks each ball down the board for real (one provably-fair
// left/right flip per peg row) and ships the exact `paths` it rolled. The
// animation REPLAYS that path peg by peg instead of running fake physics and
// then yanking the ball sideways into the server's bucket, which is what it
// used to do — with a uniform bucket picker the ball routinely had to teleport
// across half the board to reach a slot the pegs would never lead to.
//
// Each ball is a FULL copy of the displayed stake (16 balls at ₨100 charges
// ₨1,600). After they land the aggregate multiplier (Σ mult / N) is shown;
// the wallet credit is chargedStake × aggregate = perBall × Σ mult.
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
  BLUE,
} from '../game-kit';
import { useRoundFlow, animMs } from '../useRoundFlow';
import { sound } from '../../../lib/sound';
import { notify } from '../../../lib/toast';
import { PickRow, PickPrompt } from '../board-kit';
import type { GameVisualProps, GameBetPanelProps } from '../types';

/**
 * A ball replaying the server's rolled route.
 * `path[r]` is 0 (left) or 1 (right) at peg row r; `target` = Σ path = the slot.
 * `t` is progress through the current row, so the ball arcs between pegs.
 */
interface Ball {
  row: number;
  t: number;
  path: Array<0 | 1>;
  target: number;
  x: number;
  y: number;
}

const DROP_GAP_MS = 360;

/**
 * Format a bucket multiplier for the narrow slot labels.
 * The re-calibrated tables span 0.523x to 136.39x, and drawing all of those at
 * full precision made neighbouring labels overlap into an unreadable smear on a
 * 13-slot board. Short forms: 136x, 13.5x, 1.51x, .87x.
 */
export function slotLabel(m: number): string {
  if (m >= 100) return `${Math.round(m)}x`;
  if (m >= 10) return `${m.toFixed(1)}x`;
  if (m >= 1) return `${m.toFixed(2)}x`;
  return `${m.toFixed(2).replace(/^0/, '')}x`;
}

/** Draw the payout slots under the board (shared by the static and animated passes). */
function drawSlots(
  ctx: CanvasRenderingContext2D,
  multipliers: number[],
  bw: number,
  bottom: number
) {
  // Shrink the font until the widest label fits its slot, so a 13.47x board and
  // a 136.39x board are both readable.
  let font = 10;
  ctx.font = `bold ${font}px sans-serif`;
  const widest = multipliers.reduce(
    (w, m) => Math.max(w, ctx.measureText(slotLabel(m)).width),
    0
  );
  if (widest > bw - 2) font = Math.max(6, Math.floor(font * ((bw - 2) / widest)));

  multipliers.forEach((m, i) => {
    const x = 6 + i * bw;
    const color = m >= 10 ? GOLD : m >= 3 ? GREEN : m >= 1 ? BLUE : '#555';
    ctx.fillStyle = `${color}22`;
    ctx.fillRect(x, bottom, bw, 36);
    ctx.fillStyle = color;
    ctx.fillRect(x, bottom, bw, 3);
    ctx.font = `bold ${font}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(slotLabel(m), x + bw / 2, bottom + 20);
  });
}

export function PlinkoVisual({
  outcome,
  result,
  choices,
  setChoices,
  onRoundComplete,
}: GameVisualProps) {
  // Hold the result back until this game's animation has finished — the
  // banner used to fire the moment the server replied, spoiling the outcome
  // while the board was still animating.
  const ballCount = Math.max(1, Math.min(16, Number(choices.balls ?? 1)));
  // The reveal is the board's explicit `flow.complete()` when the ACTUAL last
  // ball lands — the duration below is only the dead-man fallback (with a 40%
  // margin over the scripted drop schedule).
  const flow = useRoundFlow(
    outcome,
    Math.round(1.4 * (animMs('plinko') + (ballCount - 1) * DROP_GAP_MS)),
    onRoundComplete
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rows = Number(choices.rows ?? 12);
  const [balls, setBalls] = useState<Ball[]>([]); // count/arrival state only
  const ballsRef = useRef<Ball[]>([]); // frame-by-frame physics (no React render per frame)
  const [landed, setLanded] = useState<Array<{ bucket: number; mult: number }>>([]);
  const landedRef = useRef<Array<{ bucket: number; mult: number }>>([]);
  const queueRef = useRef<number[]>([]); // buckets still to drop
  const dropTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const completeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outRef = useRef<{
    buckets?: number[];
    bucketMultipliers?: number[];
    multipliers?: number[];
  } | null>(null);

  // Everything comes from flow.outcome (the sticky round snapshot), never the
  // raw prop: it parks at null between rounds, and reading it made the slot
  // labels flash to default 1× multipliers during the next bet's flight.
  const liveOutcome = flow.outcome as {
    multipliers?: number[];
    buckets?: number[];
    paths?: Array<Array<0 | 1>>;
    aggregate?: number;
  } | null;
  const multipliers = liveOutcome?.multipliers ?? Array(rows + 1).fill(1);
  const buckets = liveOutcome?.buckets ?? [];
  // The server's actual left/right route for each ball. Older rounds (and demo
  // replays) may not carry it — fall back to a route that ends in the right
  // slot so the ball still lands where the server says.
  const paths = liveOutcome?.paths;
  const aggregate = liveOutcome?.aggregate ?? null;

  // (re)draw board: pegs + bucket labels
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth,
      H = cv.clientHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const top = 26,
      bottom = H - 44;
    const spacing = Math.min(W / (rows + 2), (bottom - top) / rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c <= r; c++) {
        const x = W / 2 + (c - r / 2) * spacing;
        const y = top + r * spacing;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fill();
      }
    }
    const bw = (W - 12) / (rows + 1);
    drawSlots(ctx, multipliers, bw, bottom);
  }, [rows, multipliers]);

  // queue the drops when the server outcome arrives
  useEffect(() => {
    if (!buckets.length) return;
    outRef.current = liveOutcome as typeof outRef.current;
    landedRef.current = [];
    ballsRef.current = [];
    setBalls([]);
    setLanded([]);
    queueRef.current = [...buckets];
    if (dropTimer.current) clearInterval(dropTimer.current);
    sound.play('plinko_peg');
    const drop = () => {
      const idx = buckets.length - queueRef.current.length;
      const next = queueRef.current.shift();
      const cv = canvasRef.current;
      if (next === undefined || !cv) {
        if (dropTimer.current) clearInterval(dropTimer.current);
        return;
      }
      // Replay the server's route. If it wasn't sent, synthesise ANY route with
      // the right number of rights so the landing slot still matches exactly.
      const path =
        paths?.[idx]?.length === rows
          ? paths[idx]!
          : (() => {
              const p: Array<0 | 1> = Array.from({ length: rows }, (_, i) =>
                i < next ? 1 : 0
              );
              for (let i = p.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [p[i], p[j]] = [p[j]!, p[i]!];
              }
              return p;
            })();
      const ball = {
        row: 0,
        t: 0,
        path,
        target: next,
        x: cv.clientWidth / 2,
        y: 16,
      } as Ball;
      ballsRef.current = [...ballsRef.current, ball];
      setBalls([...ballsRef.current]);
    };
    drop();
    dropTimer.current = setInterval(drop, DROP_GAP_MS);
    return () => {
      if (dropTimer.current) clearInterval(dropTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets]);

  // one physics loop per falling ball — STEERED to the server bucket
  useEffect(() => {
    if (buckets.length === 0) return;
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth,
      H = cv.clientHeight;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const top = 26,
      bottom = H - 44;
    const spacing = Math.min(W / (rows + 2), (bottom - top) / rows);
    const bw = (W - 12) / (rows + 1);

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      // board
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c <= r; c++) {
          const x = W / 2 + (c - r / 2) * spacing;
          const y = top + r * spacing;
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fill();
        }
      }
      drawSlots(ctx, multipliers, bw, bottom);
      // balls
      for (const b of ballsRef.current) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(b.x, b.y, 13, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(245,200,66,0.25)';
        ctx.fill();
      }
    };

    let raf = 0;
    let running = true;
    // Replay the server's route: the ball hops from peg to peg, going left or
    // right exactly as the provably-fair flips decided. `SPEED` is rows per
    // frame-unit; the arc between pegs gives it a natural bounce.
    const SPEED = 0.075;
    const step = () => {
      let anyAlive = false;
      const remaining: Ball[] = [];
      const active = ballsRef.current;
      for (const ball of active) {
        const b = { ...ball };
        b.t += SPEED;
        while (b.t >= 1 && b.row < rows) {
          b.t -= 1;
          b.row += 1;
          sound.play('plinko_peg');
        }

        if (b.row >= rows) {
          // landed — the slot is Σ path, which always equals the server bucket
          landedRef.current = [
            ...landedRef.current,
            { bucket: b.target, mult: multipliers[b.target] ?? 1 },
          ];
          setLanded(landedRef.current);
          sound.play('plinko_land');
          // The ACTUAL last ball has landed — every drop is finished, the
          // queue is empty. One beat for the aggregate count-up, then the
          // board declares the round complete. No timer guessed at this.
          if (
            landedRef.current.length >= buckets.length &&
            queueRef.current.length === 0
          ) {
            if (completeTimer.current) clearTimeout(completeTimer.current);
            completeTimer.current = setTimeout(() => flow.complete(), 950);
          }
          continue;
        }

        // horizontal position: how many rights taken so far, interpolated into
        // the next peg. On row r the ball sits between the pegs of that row.
        const rightsSoFar = b.path.slice(0, b.row).reduce((a: number, x) => a + x, 0);
        const goingRight = b.path[b.row] ?? 0;
        const colFrom = rightsSoFar - b.row / 2;
        const colTo = rightsSoFar + goingRight - (b.row + 1) / 2;
        const col = colFrom + (colTo - colFrom) * b.t;
        b.x = W / 2 + col * spacing;
        // vertical: linear down the rows, plus a small hop so it looks physical
        b.y = top + (b.row + b.t) * spacing - Math.sin(b.t * Math.PI) * spacing * 0.22;

        remaining.push(b);
        anyAlive = true;
      }
      const countChanged = remaining.length !== active.length;
      ballsRef.current = remaining;
      if (countChanged) setBalls([...remaining]);
      draw();
      if (anyAlive && running) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      if (completeTimer.current) clearTimeout(completeTimer.current);
    };
  }, [flow.roundKey, buckets, rows, multipliers]);

  const totalMult =
    landed.reduce((s, l) => s + l.mult, 0) / Math.max(1, buckets.length || 1);
  const allLanded = buckets.length > 0 && landed.length >= buckets.length;
  // Board controls are locked while balls are in flight — changing the risk
  // table mid-drop would relabel the slots the balls are already falling into.
  const dropping = balls.length > 0 || (buckets.length > 0 && !allLanded);

  return (
    <GameBackdrop accent={GOLD}>
      {/* D-101: scroll-safe wrapper — centers when it fits, scrolls on short
          viewports so the board + controls are never cut off */}
      <div className="relative w-full h-full overflow-y-auto">
        <div className="min-h-full w-full flex flex-col items-center justify-center gap-2 px-2 py-2">
          <PickPrompt show={!outcome}>
            Choose risk and how many balls before you drop
          </PickPrompt>
          <div className="w-full max-w-md flex-1 min-h-[230px] sm:min-h-[260px] relative">
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
            {/* live per-ball chips */}
            {landed.length > 0 && (
              <div className="absolute top-1 left-0 right-0 flex flex-wrap gap-1 justify-center">
                {landed.map((l, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 rounded-full text-[10px] font-black animate-spring-in"
                    style={{
                      color: l.mult >= 3 ? '#003d20' : '#fff',
                      background:
                        l.mult >= 10
                          ? GOLD
                          : l.mult >= 3
                            ? GREEN
                            : 'rgba(255,255,255,0.2)',
                    }}
                  >
                    {l.mult}×
                  </span>
                ))}
              </div>
            )}
            {/* aggregate result */}
            {allLanded && (
              <div className="absolute bottom-10 left-0 right-0 flex justify-center">
                <Glass
                  className="px-5 py-2 animate-spring-in"
                  glow={aggregate !== null && aggregate >= 1 ? GREEN : RED}
                >
                  <span
                    className={`t-headline ${aggregate !== null && aggregate >= 1 ? 'text-green' : 'text-white/60'}`}
                  >
                    TOTAL <CountUp value={totalMult} decimals={2} duration={900} />×
                  </span>
                </Glass>
              </div>
            )}
            {!buckets.length && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="t-label-sm text-white/30">
                  {choices.balls && Number(choices.balls) > 1
                    ? `Drop ${choices.balls} balls`
                    : 'Drop a ball to see the physics'}
                </span>
              </div>
            )}
          </div>

          {/* RISK + BALLS live on the board, right under the pegs they change.
            They used to be inside the bet popup, so you configured the board on
            one screen and watched it on another. Changing risk instantly
            redraws the payout slots, which is the whole point of seeing them. */}
          <div className="w-full max-w-md space-y-1.5">
            <PickRow
              columns={3}
              disabled={dropping}
              value={String(choices.risk ?? 'medium')}
              onChange={(v) => setChoices({ ...choices, risk: v })}
              options={[
                { value: 'low', label: 'LOW', sub: 'steady', color: GREEN },
                { value: 'medium', label: 'MEDIUM', sub: 'balanced', color: GOLD },
                { value: 'high', label: 'HIGH', sub: 'swingy', color: RED },
              ]}
            />
            <div className="flex items-center gap-2">
              <span className="t-label-sm text-white/45 shrink-0">Balls</span>
              <div className="grid grid-cols-4 gap-1.5 flex-1">
                {[1, 4, 8, 16].map((b) => (
                  <button
                    key={b}
                    disabled={dropping}
                    onClick={() => {
                      setChoices({ ...choices, balls: b });
                      if (b > 1)
                        notify.info(
                          `${b} balls: each is a full bet. We'll charge ${b}× your stake.`
                        );
                    }}
                    className={`h-8 rounded-lg t-num-md transition-all disabled:opacity-40 ${Number(choices.balls ?? 1) === b ? 'bg-gold/15 border border-gold/40 text-gold' : 'bg-white/5 border border-white/8 text-white/60 active:scale-95'}`}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
            {ballCount > 1 && (
              <p className="t-label-sm text-gold/85 text-center">
                {ballCount} balls × your stake — total charge is {ballCount}×
              </p>
            )}
          </div>

          <ResultBanner
            ready={flow.revealed}
            roundKey={flow.roundKey}
            result={result}
            multiplier={(outcome as { aggregate?: number })?.aggregate}
            payout={(outcome as { payout?: number })?.payout}
            partialRefund={(outcome as { partialRefund?: boolean })?.partialRefund}
            accent={GOLD}
          />
        </div>
      </div>
    </GameBackdrop>
  );
}

export function PlinkoBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  // Risk and ball count are board controls now — nothing game-related here.
  const n = Number(choices.balls ?? 1);
  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel={n > 1 ? `DROP ${n} BALLS` : 'DROP THE BALL'}
      selection={
        n > 1
          ? `${String(choices.risk ?? 'medium').toUpperCase()} risk · ${n} balls (each a full bet)`
          : `${String(choices.risk ?? 'medium').toUpperCase()} risk · 1 ball`
      }
      units={n > 1 ? { count: n, label: 'balls' } : null}
    />
  );
}
