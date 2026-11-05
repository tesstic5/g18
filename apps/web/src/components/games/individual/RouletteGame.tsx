// apps/web/src/components/games/individual/RouletteGame.tsx — REAL roulette (D-093):
// full European table (straight / split / street / corner / six-line / column /
// dozen / red / black / odd / even / low / high) + canvas wheel with a ball that
// circles, decelerates and drops into the winning pocket. Server outcome drives it.
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { BetBar } from '../../BetBar';
import { GameBackdrop, ResultBanner, Glass, GOLD } from '../game-kit';
import { useRoundFlow, flowFallbackMs } from '../useRoundFlow';
import { sound } from '../../../lib/sound';
import { vibrate } from '../../../hooks';
import type { GameVisualProps, GameBetPanelProps } from '../types';

// ── European layout ────────────────────────────────────────────────────────
const ROWS: number[][] = [
  [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36],
  [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
  [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34],
];
const EUROPEAN_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33,
  1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];
const RED_POCKETS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);
const colorOf = (n: number): 'red' | 'black' | 'green' =>
  n === 0 ? 'green' : RED_POCKETS.has(n) ? 'red' : 'black';
// black was #1b1b26 — almost exactly the board's own background, so on a phone
// half the table looked like empty space rather than bettable pockets.
const CELL_BG: Record<string, string> = {
  red: '#c0392b',
  black: '#31313f',
  green: '#0e7a3c',
};
const PAYOUTS: Record<string, number> = {
  straight: 36,
  split: 18,
  street: 12,
  corner: 9,
  six_line: 6,
  dozen: 3,
  column: 3,
  red: 2,
  black: 2,
  odd: 2,
  even: 2,
  low: 2,
  high: 2,
};

type Bet = { type: string; number?: number; numbers?: number[]; column?: number };
type Cell = { r: number; c: number };

function detectMultiBet(cells: Cell[]): { type: string; numbers: number[] } | null {
  const n = (c: Cell) => ROWS[c.r]![c.c]!;
  if (cells.length === 2) {
    const a = cells[0]!;
    const b = cells[1]!;
    const adj =
      (Math.abs(a.r - b.r) === 1 && a.c === b.c) ||
      (a.r === b.r && Math.abs(a.c - b.c) === 1);
    return adj ? { type: 'split', numbers: [n(a), n(b)] } : null;
  }
  if (cells.length === 3) {
    const s = [...cells].sort((x, y) => x.r - y.r);
    if (
      s[0]!.c === s[1]!.c &&
      s[1]!.c === s[2]!.c &&
      s[1]!.r - s[0]!.r === 1 &&
      s[2]!.r - s[1]!.r === 1
    )
      return { type: 'street', numbers: s.map(n) };
    return null;
  }
  if (cells.length === 4 || cells.length === 6) {
    const rs = new Set(cells.map((c) => c.r));
    const cs = new Set(cells.map((c) => c.c));
    const target = cells.length === 4 ? [2, 2] : [3, 2];
    if (rs.size === target[0] && cs.size === target[1]) {
      let ok = true;
      for (const r of rs)
        for (const c of cs) if (!cells.some((x) => x.r === r && x.c === c)) ok = false;
      if (ok)
        return {
          type: cells.length === 4 ? 'corner' : 'six_line',
          numbers: cells.map(n),
        };
    }
  }
  return null;
}

// ── Canvas wheel with a ball ───────────────────────────────────────────────
/**
 * Paint the wheel at rest.
 *
 * The spin animation drew every frame itself, but it only ran once a pocket had
 * been chosen — so before the first spin (and on a freshly opened page) the
 * canvas was never touched and the roulette wheel was simply INVISIBLE. All the
 * player saw above the betting table was a blank gap, which is a large part of
 * "some game elements are not fitting in properly": the element was there and
 * taking up space, it just had nothing drawn on it.
 */
function drawRestingWheel(cv: HTMLCanvasElement | null) {
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const W = cv.width,
    C = W / 2,
    segW = 360 / 37;
  ctx.clearRect(0, 0, W, W);
  for (let i = 0; i < 37; i++) {
    const num = EUROPEAN_ORDER[i]!;
    const a0 = ((i * segW - 90) * Math.PI) / 180;
    const a1 = (((i + 1) * segW - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(C, C);
    ctx.arc(C, C, 260, a0, a1);
    ctx.closePath();
    ctx.fillStyle = CELL_BG[colorOf(num)]!;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const mid = (a0 + a1) / 2;
    ctx.save();
    ctx.translate(C + Math.cos(mid) * 200, C + Math.sin(mid) * 200);
    ctx.rotate(mid + Math.PI / 2);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 17px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), 0, 0);
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(C, C, 96, 0, Math.PI * 2);
  ctx.fillStyle = '#101018';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(C, C, 62, 0, Math.PI * 2);
  const hub = ctx.createRadialGradient(C - 18, C - 18, 6, C, C, 62);
  hub.addColorStop(0, '#3a3a55');
  hub.addColorStop(1, '#15152a');
  ctx.fillStyle = hub;
  ctx.fill();
  // ball parked in its track
  const bx = C,
    by = C - 216;
  const bg = ctx.createRadialGradient(bx - 3, by - 3, 2, bx, by, 11);
  bg.addColorStop(0, '#ffffff');
  bg.addColorStop(1, '#9aa0aa');
  ctx.beginPath();
  ctx.arc(bx, by, 10, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();
}

function Wheel({
  pocket,
  spinKey,
  onDone,
}: {
  pocket: number | null;
  spinKey: number;
  /** the wheel's own completion report — fired when the ball has settled in
   * the pocket and the highlight ring is drawn */
  onDone?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<'idle' | 'spinning' | 'done'>('idle');
  const animRef = useRef(0);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (pocket === null) {
      setPhase('idle');
      return;
    }
    setPhase('spinning');
    sound.play('wheel_spin');
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const W = cv.width,
      H = cv.height,
      C = W / 2;
    const segW = 360 / 37;
    const pocketIdx = EUROPEAN_ORDER.indexOf(pocket);
    const target = 5 * 360 - (pocketIdx * segW + segW / 2); // bring pocket center to the top pointer
    const duration = 4200;
    const start = performance.now();
    let done = false;

    const draw = (p: number) => {
      const ease = 1 - Math.pow(1 - p, 3);
      const rot = target * ease;
      ctx.clearRect(0, 0, W, H);
      // segments
      for (let i = 0; i < 37; i++) {
        const num = EUROPEAN_ORDER[i]!;
        const a0 = ((i * segW + rot - 90) * Math.PI) / 180;
        const a1 = (((i + 1) * segW + rot - 90) * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(C, C);
        ctx.arc(C, C, 260, a0, a1);
        ctx.closePath();
        ctx.fillStyle = CELL_BG[colorOf(num)]!;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // number
        const mid = (a0 + a1) / 2;
        ctx.save();
        ctx.translate(C + Math.cos(mid) * 200, C + Math.sin(mid) * 200);
        ctx.rotate(mid + Math.PI / 2);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 17px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(num), 0, 0);
        ctx.restore();
      }
      // inner hub
      ctx.beginPath();
      ctx.arc(C, C, 96, 0, Math.PI * 2);
      ctx.fillStyle = '#101018';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(C, C, 62, 0, Math.PI * 2);
      const hub = ctx.createRadialGradient(C - 18, C - 18, 6, C, C, 62);
      hub.addColorStop(0, '#3a3a55');
      hub.addColorStop(1, '#15152a');
      ctx.fillStyle = hub;
      ctx.fill();
      // ball
      const ballRel = (1 - p) * 9 * 360;
      const ballAngle = ((rot + ballRel) * Math.PI) / 180;
      const rad = p < 0.8 ? 216 : 216 - ((p - 0.8) / 0.2) * 44;
      const bx = C + Math.cos(ballAngle) * rad;
      const by = C + Math.sin(ballAngle) * rad;
      const bg = ctx.createRadialGradient(bx - 3, by - 3, 2, bx, by, 11);
      bg.addColorStop(0, '#ffffff');
      bg.addColorStop(1, '#9aa0aa');
      ctx.beginPath();
      ctx.arc(bx, by, 10, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.shadowColor = 'rgba(255,255,255,0.7)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(bx, by, 10, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    const loop = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      draw(p);
      if (p < 1) {
        animRef.current = requestAnimationFrame(loop);
      } else if (!done) {
        done = true;
        setPhase('done');
        sound.stop('wheel_spin');
        sound.play('wheel_stop');
        // The ball has settled and the pocket is lit — the board declares the
        // round complete. Nothing upstream times or guesses this moment.
        onDoneRef.current?.();
        // final pocket highlight ring
        const pIdx = EUROPEAN_ORDER.indexOf(pocket);
        const a0 = ((pIdx * segW - 90) * Math.PI) / 180;
        const a1 = (((pIdx + 1) * segW - 90) * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(C, C);
        ctx.arc(C, C, 260, a0, a1);
        ctx.closePath();
        ctx.fillStyle = 'rgba(245,200,66,0.35)';
        ctx.fill();
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(C, C, 268, 0, Math.PI * 2);
        ctx.strokeStyle = `${GOLD}66`;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [pocket, spinKey]);

  // Paint the wheel whenever it is NOT spinning, so it is visible on arrival
  // and stays on screen between rounds instead of blanking out.
  useEffect(() => {
    if (pocket === null) drawRestingWheel(canvasRef.current);
  }, [pocket]);

  return (
    // The wheel used to cap at 150px (w-[min(42vw,150px,17dvh)]) — on a real
    // monitor it measured 11% of the viewport width and read as a coin
    // instead of the centrepiece of the game. The wheel IS the roulette; it
    // now owns the visual stage (≈2x bigger on every screen).
    <div className="relative w-[min(72vw,320px,36dvh)] aspect-square mx-auto">
      {/* pointer */}
      <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 z-20">
        <div className="w-0 h-0 border-l-[12px] border-r-[12px] border-t-[20px] border-l-transparent border-r-transparent border-t-gold drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]" />
      </div>
      <div
        className="absolute -inset-3 rounded-full animate-float-slow"
        style={{
          background: 'radial-gradient(circle, rgba(245,200,66,0.10), transparent 65%)',
        }}
      />
      <canvas
        ref={canvasRef}
        width={600}
        height={600}
        className="w-full h-full drop-shadow-[0_14px_34px_rgba(0,0,0,0.6)]"
      />
      {/* result chip */}
      {phase === 'done' && pocket !== null && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20">
          <Glass className="px-5 py-1.5 animate-spring-in" glow={GOLD}>
            <span
              className="t-headline"
              style={{
                color:
                  colorOf(pocket) === 'green'
                    ? '#00d97e'
                    : colorOf(pocket) === 'red'
                      ? '#ff5c7a'
                      : '#fff',
              }}
            >
              {pocket} {colorOf(pocket).toUpperCase()}
            </span>
          </Glass>
        </div>
      )}
    </div>
  );
}

// ── Main visual ────────────────────────────────────────────────────────────
export function RouletteVisual({
  outcome,
  result,
  choices,
  setChoices,
  onRoundComplete,
}: GameVisualProps) {
  // Hold the result back until the wheel has actually stopped — completion is
  // the wheel's own onDone report, not a timer guessing at the spin's length.
  const flow = useRoundFlow(outcome, flowFallbackMs('roulette'), onRoundComplete);
  // flow.outcome (sticky), not the raw prop — it parks at null between rounds
  // and must not cancel a new round's spin for an identical pocket.
  const res = flow.outcome as {
    pocket?: number;
    color?: string;
    win?: boolean;
    multiplier?: number;
  } | null;
  // Start with NO bet — the player must place a chip on the table. It used to
  // default to red, so a round could be staked without the player ever
  // touching the table.
  const [bet, setBet] = useState<Bet | null>(() => {
    const b = choices.bet as Bet | undefined;
    return b?.type ? b : null;
  });
  const [multi, setMulti] = useState(false);
  const [multiCells, setMultiCells] = useState<Cell[]>([]);
  const [flash, setFlash] = useState<number | null>(null);

  // sync local bet → page choices (what gets sent with the bet)
  useEffect(() => {
    if (bet) setChoices({ ...choices, bet });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bet]);

  // The pocket flash is keyed on ROUND IDENTITY, not the pocket value: an
  // identical pocket on back-to-back rounds is still a new spin and must
  // flash again (the old `[res?.pocket]` dep never re-fired, so round 2
  // showed its answer without the wheel ever turning).
  //
  // And it must outlive the 4200ms spin: the old 3200ms clear yanked `pocket`
  // away from <Wheel> 1000ms before the ball landed, which re-ran its effect
  // with pocket=null, cancelled the RAF loop mid-flight and froze the wheel —
  // every single spin was silently aborting before the finish.
  useEffect(() => {
    if (res?.pocket === undefined || res?.pocket === null) return;
    const pocket = res.pocket;
    setFlash(pocket);
    const t = setTimeout(() => setFlash(null), 5200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.roundKey]);

  const pick = (b: Bet) => {
    setBet(b);
    setMultiCells([]);
    vibrate(8);
    sound.play('bet_place');
  };

  const toggleMultiCell = (cell: Cell) => {
    const exists = multiCells.some((x) => x.r === cell.r && x.c === cell.c);
    if (exists) {
      const next = multiCells.filter((x) => x.r !== cell.r || x.c !== cell.c);
      setMultiCells(next);
      const d = detectMultiBet(next);
      setBet(d ? { type: d.type, numbers: d.numbers } : null);
      return;
    }
    if (multiCells.length >= 6) return;
    // must be edge-adjacent to an existing cell (or first cell)
    if (
      multiCells.length > 0 &&
      !multiCells.some(
        (x) =>
          (Math.abs(x.r - cell.r) === 1 && x.c === cell.c) ||
          (x.r === cell.r && Math.abs(x.c - cell.c) === 1)
      )
    ) {
      return;
    }
    const next = [...multiCells, cell];
    setMultiCells(next);
    const d = detectMultiBet(next);
    setBet(d ? { type: d.type, numbers: d.numbers } : null);
  };

  const betLabel = bet
    ? `${bet.type.replace('_', ' ')} ${PAYOUTS[bet.type] ?? ''}×`
    : 'pick your bet';

  return (
    <GameBackdrop accent={GOLD} fit={false}>
      {/* D-096: scroll-safe wrapper — centers when short, scrolls from the top
          when the table is taller than the canvas on small phones */}
      <div className="relative w-full h-full overflow-y-auto">
        <div className="min-h-full w-full flex flex-col items-center justify-center gap-2 px-2 py-2">
          {/* WHEEL — spin identity is the ROUND, not the pocket number: two
              identical pockets in a row must still produce two full spins */}
          <Wheel pocket={flash} spinKey={flow.roundKey} onDone={flow.complete} />

          {/* WHAT AM I PLAYING — the persistent strip that kills the
             "kinda confusing" report: the selected bet reads in words and
             numbers with its payout, or the table nags you to pick one. It
             used to be two cryptic chips in opposite corners. */}
          <div className="w-full max-w-[400px]">
            <div
              className={`mx-auto flex items-center justify-between gap-3 rounded-xl border px-3 py-2 ${
                bet ? 'border-gold/40 bg-gold/10' : 'border-white/10 bg-white/[0.03]'
              }`}
            >
              <span className="t-label-sm text-white/55 tracking-wide shrink-0">
                {bet ? 'YOUR BET' : 'NO BET YET'}
              </span>
              {bet ? (
                <span className="text-[12px] font-black text-gold text-right leading-tight">
                  {bet.type.replace(/_/g, ' ').toUpperCase()}
                  {bet.number !== undefined ? ` ${bet.number}` : ''}
                  {bet.numbers?.length ? ` ${bet.numbers.join('·')}` : ''}
                  {bet.column !== undefined ? ` COL ${bet.column}` : ''}
                  {' · '}
                  <span className="text-gold/75">pays {PAYOUTS[bet.type] ?? '?'}×</span>
                </span>
              ) : (
                <span className="text-[11px] font-bold text-white/50 text-right leading-tight">
                  tap a number, 2:1, dozens, or red/black on the table ↓
                </span>
              )}
            </div>
          </div>

          {/* TABLE */}
          <div className="w-full max-w-[360px] select-none">
            {/* mode + status */}
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex gap-1.5">
                <button
                  onClick={() => {
                    setMulti(false);
                    setMultiCells([]);
                  }}
                  className={`h-8 px-3 rounded-full t-label-md ${!multi ? 'bg-gold/15 border border-gold/40 text-gold' : 'bg-white/5 border border-white/8 text-white/50'}`}
                >
                  Single
                </button>
                <button
                  onClick={() => {
                    setMulti(true);
                    setBet(null);
                    setMultiCells([]);
                  }}
                  className={`h-8 px-3 rounded-full t-label-md ${multi ? 'bg-gold/15 border border-gold/40 text-gold' : 'bg-white/5 border border-white/8 text-white/50'}`}
                >
                  Split+
                </button>
                <button
                  onClick={() => {
                    setBet(null);
                    setMultiCells([]);
                  }}
                  className="h-8 px-3 rounded-full bg-white/5 border border-white/8 text-white/50 t-label-md"
                >
                  ✕ Clear
                </button>
              </div>
              <span className="t-label-sm text-gold">{betLabel}</span>
            </div>

            {multi && (
              <p className="t-label-sm text-muted text-center mb-1.5">
                Tap adjacent numbers — 2 = Split 18× · 3 = Street 12× · 4 = Corner 9× ·
                6 = Six-line 6×
              </p>
            )}

            {/*
            PORTRAIT TABLE (3 columns x 12 rows).

            It used to be the landscape casino layout (12 columns x 3 rows)
            squeezed into a ~300px phone column. Measured: 64 of the 76 tap
            targets were under 28px, with the number cells at 15x13px — about a
            third of the 44px minimum both Apple and Google publish. On a real
            phone you cannot reliably hit "17"; you hit 14 or 20 and put money
            on the wrong number.

            Rotating the table is what mobile casino apps actually do: same
            bets, same adjacency for splits/streets, but each number now gets
            roughly 3x the area.
          */}
            <div className="rounded-xl overflow-hidden border border-white/10">
              {/* 0 across the top */}
              <button
                onClick={() => pick({ type: 'straight', number: 0 })}
                className={`w-full h-7 flex items-center justify-center font-black text-white border-b border-white/10 transition-all ${flash === 0 ? 'ring-2 ring-gold shadow-[0_0_14px_rgba(245,200,66,0.7)]' : ''} ${bet?.type === 'straight' && bet.number === 0 ? 'bg-gold/30 ring-1 ring-gold' : ''}`}
                style={{ background: '#0e7a3c' }}
              >
                0
              </button>

              <div className="flex">
                {/* 3 x 12 number grid */}
                <div
                  className="grid flex-1 min-w-0"
                  style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}
                >
                  {Array.from({ length: 12 }).map((_, rowIdx) =>
                    [0, 1, 2].map((colIdx) => {
                      // ROWS is stored landscape as ROWS[band][rowIdx]; reading
                      // band 2-colIdx keeps 1,2,3 running left to right.
                      const r = 2 - colIdx;
                      const c = rowIdx;
                      const num = ROWS[r]![c]!;
                      const sel = bet?.type === 'straight' && bet.number === num;
                      const selMulti = multiCells.some((x) => x.r === r && x.c === c);
                      const won = flash === num;
                      return (
                        <button
                          key={num}
                          onClick={() =>
                            multi
                              ? toggleMultiCell({ r, c })
                              : pick({ type: 'straight', number: num })
                          }
                          className={`min-w-0 h-9 flex items-center justify-center text-[13px] font-bold border border-white/10 transition-all ${won ? 'ring-2 ring-gold shadow-[0_0_14px_rgba(245,200,66,0.7)] z-10 scale-110' : ''} ${sel ? 'bg-gold/30 text-gold ring-1 ring-gold' : selMulti ? 'bg-gold/20 text-gold' : 'text-white/85 hover:brightness-125'}`}
                          style={{ background: CELL_BG[colorOf(num)] }}
                        >
                          {num}
                        </button>
                      );
                    })
                  )}
                </div>

                {/* street strip (right) */}
                <div
                  className="w-11 grid shrink-0"
                  style={{ gridTemplateRows: 'repeat(12, minmax(0,1fr))' }}
                >
                  {Array.from({ length: 12 }).map((_, c) => {
                    const nums = [3 * c + 1, 3 * c + 2, 3 * c + 3];
                    const sel =
                      bet?.type === 'street' &&
                      bet.numbers?.length === 3 &&
                      nums.every((n) => bet.numbers!.includes(n));
                    return (
                      <button
                        key={c}
                        onClick={() => pick({ type: 'street', numbers: nums })}
                        className={`border-b border-l border-white/10 text-[9px] font-bold flex items-center justify-center transition-colors ${sel ? 'bg-gold/30 text-gold' : 'bg-[#0d2a1a] text-green/70 hover:bg-green/15'}`}
                      >
                        {3 * c + 1}-{3 * c + 3}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 2:1 column bets under the column they pay */}
              <div
                className="grid"
                style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr)) 44px' }}
              >
                {[1, 2, 3].map((col) => {
                  const nums = Array.from({ length: 12 }, (_, i) => 3 * i + col);
                  const sel = bet?.type === 'column' && bet.column === col;
                  const won = flash !== null && nums.includes(flash);
                  return (
                    <button
                      key={col}
                      onClick={() => pick({ type: 'column', column: col })}
                      className={`h-7 border-t border-r border-white/10 text-xs font-black transition-colors ${won ? 'bg-gold/40 text-gold' : sel ? 'bg-gold/30 text-gold' : 'bg-[#0d2a1a] text-green/80 hover:bg-green/15'}`}
                    >
                      2:1
                    </button>
                  );
                })}
                <div className="border-t border-white/10 bg-[#0d2a1a]" />
              </div>

              {/* dozens */}
              <div className="grid grid-cols-3">
                {(
                  [
                    ['1st 12', 1],
                    ['2nd 12', 2],
                    ['3rd 12', 3],
                  ] as const
                ).map(([label, d]) => {
                  const nums = Array.from(
                    { length: 12 },
                    (_, i) => 12 * (d - 1) + i + 1
                  );
                  const sel = bet?.type === `dozen-${d}`;
                  const won = flash !== null && nums.includes(flash);
                  return (
                    <button
                      key={d}
                      onClick={() => pick({ type: `dozen-${d}` })}
                      className={`h-8 text-[10px] sm:text-xs font-black border-r border-t border-white/10 transition-colors ${won ? 'bg-gold/40 text-gold' : sel ? 'bg-gold/30 text-gold' : 'bg-[#10101c] text-white/60 hover:bg-white/10'}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              {/* outside bets */}
              <div className="grid grid-cols-6">
                {(
                  [
                    ['1-18', 'low'],
                    ['EVEN', 'even'],
                    ['RED', 'red'],
                    ['BLACK', 'black'],
                    ['ODD', 'odd'],
                    ['19-36', 'high'],
                  ] as const
                ).map(([label, type]) => {
                  const sel = bet?.type === type;
                  const won =
                    flash !== null &&
                    ((type === 'red' && colorOf(flash) === 'red') ||
                      (type === 'black' && colorOf(flash) === 'black') ||
                      (type === 'even' && flash !== 0 && flash % 2 === 0) ||
                      (type === 'odd' && flash !== 0 && flash % 2 === 1) ||
                      (type === 'low' && flash >= 1 && flash <= 18) ||
                      (type === 'high' && flash >= 19 && flash <= 36));
                  const base =
                    type === 'red'
                      ? 'bg-[#5c1a14]'
                      : type === 'black'
                        ? 'bg-[#14141e]'
                        : 'bg-[#10101c]';
                  return (
                    <button
                      key={type}
                      onClick={() => pick({ type })}
                      className={`h-9 text-[9px] sm:text-[10px] font-black border-r border-t border-white/10 transition-colors ${won ? 'bg-gold/40 text-gold' : sel ? 'bg-gold/30 text-gold' : `${base} text-white/60 hover:bg-white/10`}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <ResultBanner
            ready={flow.revealed}
            roundKey={flow.roundKey}
            result={result}
            multiplier={res?.multiplier}
            payout={
              result === 'WIN' ? (outcome as { payout?: number })?.payout : undefined
            }
            accent={GOLD}
          />
        </div>
      </div>
    </GameBackdrop>
  );
}

export function RouletteBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  // The full betting table is on the board — this only stakes and confirms.
  const bet = (choices.bet ?? null) as Bet | null;
  const label = bet?.type ? `${bet.type.replace(/_/g, ' ').toUpperCase()}` : '';
  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel={label ? `SPIN \u2014 ${label}` : 'SPIN'}
      selection={
        label
          ? `${label}${bet?.number !== undefined ? ` on ${bet.number}` : ''}${bet?.numbers?.length ? ` on ${bet.numbers.join(', ')}` : ''}`
          : null
      }
      requirement={bet?.type ? null : 'Tap the table to place a bet'}
      multiplier={bet?.type ? (PAYOUTS[bet.type] ?? null) : null}
    />
  );
}
