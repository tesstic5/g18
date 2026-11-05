// apps/web/src/components/games/individual/AviatorGame.tsx
// ─────────────────────────────────────────────────────────────────────────────
// REDESIGN: classic Spribe-style Aviator layout (per player reference
// screenshots). The ENGINE and the socket flow are untouched — only the skin:
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ [H] [🎁] [»]   3.11x  14.67x  7.64x  54.60x  …  (history ticker)     │
//   ├─────────────────┬──────────────────────────────────────────────────┤
//   │ All Bets │My│Top│           (purple glow)                          │
//   │ ALL BETS  226   │                2.83x                             │
//   │ 🧸 a***e  150  2.83x│          (red plane rides the               │
//   │ ◼◼ 12,683.00   │            red-filled curve)                      │
//   │ …               │        FLEW AWAY!  12.86x   (crash state)        │
//   ├─────────────────┴──────────────────────────────────────────────────┤
//   │ [Bet|Auto]  − 200 +  [100][200][500][1000]   [   BET   ] (slot 1) │
//   │ [Bet|Auto]  − 200 +  [100][200][500][1000]   [   BET   ] (slot 2) │
//   └────────────────────────────────────────────────────────────────────┘
//
// HARD CONSTRAINTS HONOURED (engine/page realities — do not regress):
//  · every payload number passes num() before render (a null historically
//    unmounted the whole game behind the error boundary, mid-round, with
//    money on the table).
//  · results shown are always server truth via {slug}:my-result → page sets
//    `outcome`/`result` props → banners here.
//  · ONE live bet per user — the server enforces it (GAME_007) AND the page
//    placeBet() re-entry guard SKIPs a 2nd call while PLAYING. So slot 2's
//    bet while slot 1 rides → QUEUED locally ("Waiting for next round") and
//    auto-placed the instant {slug}:round-start lands — exactly how Spribe
//    treats bets made after the betting window.
//  · crash-x re-uses both exports with its own eventPrefix.
//  · operator decision 2026-08-21: NO auto-betting in ANY game. The Auto BET
//    toggle is gone everywhere; only AUTO ESCAPE (auto-cash-out) remains —
//    matching the reference screenshots, where the escape row reads "off".
'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sound } from '../../../lib/sound';
import { socket } from '../../../lib/app';
import { safeSession } from '../../../lib/safe-storage';
import { useAuthStore } from '../../../stores';
import {
  getMyCrashBet,
  onMyCrashBet,
  setMyCrashBet,
  clearMyCrashBet,
  fetchCrashState,
} from '../../../lib/crash-bet';
import type { GameVisualProps, GameBetPanelProps } from '../types';

// ── palette (Spribe dark) ────────────────────────────────────────────────────
const BG = '#0d1015';
const PANEL = '#11151d';
const LINE_RED = '#e2002f';
const GLOW_PURPLE = 'rgba(140, 40, 220, 0.55)';
const BET_GREEN = '#2fb765';
const CASH_ORANGE = '#f2993a';
const MONEY = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Must match apps/api AviatorGame.CRASH_TAXI_MS (0.10 → 1.00 taxi). */
const CRASH_TAXI_MS = 2500;
/** Infer the live e^(g·t) constant from a server tick. The old `ln(m)/elapsed`
 *  treated taxi+climb as one exponential, so the HUD lagged then jumped. */
function inferCrashGrowth(m: number, elapsedMs: number): number | null {
  if (!(elapsedMs > 0) || !Number.isFinite(m)) return null;
  if (elapsedMs < CRASH_TAXI_MS) return Math.log(10) / CRASH_TAXI_MS;
  if (m > 1) {
    const g = Math.log(m) / (elapsedMs - CRASH_TAXI_MS);
    return Number.isFinite(g) && g > 0 ? g : null;
  }
  return null;
}

// Every number rendered here comes off a socket payload, and the HUD calls
// .toFixed() on it every frame. A single missing/malformed field used to set
// state to undefined/null and the next render threw
//   TypeError: Cannot read properties of null (reading 'toFixed')
// which unmounts the whole game behind the error boundary — mid-round, with
// the player's money on the table. num() guarantees a finite number.
// NOTE: only numbers and numeric strings are accepted. A bare Number()
// conversion would turn null into 0, '' into 0 and true into 1, so a dropped
// field would silently render "0.00x" instead of the last good value.
function num(v: unknown, fallback: number): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** history-pill colour, exactly like Spribe: small = blue, mid = purple, huge = pink */
function histHue(m: number) {
  if (m >= 10)
    return { fg: '#ff49a8', bg: 'rgba(255,73,168,0.12)', bd: 'rgba(255,73,168,0.4)' };
  if (m >= 2)
    return { fg: '#b05cff', bg: 'rgba(176,92,255,0.12)', bd: 'rgba(176,92,255,0.4)' };
  return { fg: '#4aa8ff', bg: 'rgba(74,168,255,0.12)', bd: 'rgba(74,168,255,0.35)' };
}

/** deterministic emoji avatar + tint for a masked player label (Spribe-style). */
const AVATARS = [
  '🧸',
  '🦅',
  '🐯',
  '🚀',
  '🎯',
  '🔥',
  '👑',
  '🐺',
  '⚡',
  '🎰',
  '🦁',
  '🃏',
];
function avatarFor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  h = Math.abs(h);
  return { emoji: AVATARS[h % AVATARS.length], hue: h % 360 };
}

// ── shared round-feed row (one per OTHER player's bet, from server broadcasts)
interface BetRow {
  user: string;
  amount: number;
  at?: number; // multiplier they cashed at
  payout?: number; // what they took home
  cashed: boolean;
  busted: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// VISUAL — board + history ticker + side bets panel
// ════════════════════════════════════════════════════════════════════════════
export function AviatorVisual({ outcome, result, eventPrefix }: GameVisualProps) {
  const prefix = eventPrefix ?? 'aviator';
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const curveRef = useRef<Array<{ t: number; m: number }>>([]);
  const planeRef = useRef<{ x: number; y: number }>({ x: 30, y: 200 });
  const planeDomRef = useRef<HTMLDivElement>(null);
  const flightStartedAtRef = useRef<number>(0);
  const crashedAtRef = useRef(0);
  // ── smooth-flight model: server ticks at 50ms (20Hz) + 60fps RAF extrapolation.
  // Optimized: time-based curve sampling (no unbounded pts growth), DOM plane
  // composited via transform3d, no per-frame shadowBlur — 60fps locked even on low-end.
  const lastTickRef = useRef<{ m: number; at: number }>({ m: 1, at: 0 });
  const growthRef = useRef(0.00016);
  const shownMultRef = useRef(1);
  const hudMainRef = useRef<HTMLParagraphElement>(null);
  const hudChipRef = useRef<HTMLSpanElement>(null);

  const [multRawState, setMultRawState] = useState(0.1); // v1.3.7: taxi starts at 0.10x
  const [countdownLeft, setCountdownLeft] = useState(0);
  const [status, setStatus] = useState<'countdown' | 'flying' | 'crashed'>('countdown');
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    if (status !== 'countdown' || countdownLeft <= 0) return;
    const t = window.setTimeout(
      () => setCountdownLeft((c) => Math.max(0, c - 1)),
      1000
    );
    return () => window.clearTimeout(t);
  }, [status, countdownLeft]);
  const mult = multRawState; // React-level value: updated at coarse cadence only
  const lastPushRef = useRef(0);
  const [history, setHistory] = useState<number[]>([]);
  const [liveBets, setLiveBets] = useState<
    Array<{ user: string; amount: number; at?: number }>
  >([]);
  const [rows, setRows] = useState<BetRow[]>([]);
  const [myBet, setMyBet] = useState<ReturnType<typeof getMyCrashBet>>(null);
  const myBetRef = useRef<ReturnType<typeof getMyCrashBet>>(null);
  const [tab, setTab] = useState<'all' | 'my' | 'top'>('all');
  const [myResults, setMyResults] = useState<
    Array<{ result: string; multiplier: number; payout: number; at: number }>
  >([]);
  const [mobilePanel, setMobilePanel] = useState(false);
  const user = useAuthStore((s) => s.user);

  const crashPoint = num((outcome as { crashPoint?: number })?.crashPoint, 0);
  const [liveCrashPoint, setLiveCrashPoint] = useState(0);
  const shownCrash = liveCrashPoint || crashPoint;

  useEffect(() => onMyCrashBet(() => setMyBet(getMyCrashBet())), []);

  // v1.3.4 — JOIN/REFRESH SNAPSHOT. Before this, a client that opened (or
  // refreshed) Aviator mid-round sat on "Waiting for next round" with an
  // empty history strip until the current round ended — on long flights it
  // looked frozen even though the plane was at 6x, and mid-flight ticks then
  // popped the board in with no takeoff. Hydrate the round state + recent
  // crash points the moment the visual mounts.
  useEffect(() => {
    let dead = false;
    void fetchCrashState(prefix).then((st) => {
      if (dead || !st) return;
      if (st.recent.length) setHistory(st.recent.slice(0, 18));
      const r = st.round;
      if (!r) return;
      if (r.status === 'flying' && statusRef.current !== 'flying') {
        lastTickRef.current = { m: r.multiplier, at: performance.now() };
        setStatus('flying');
        sound.play('crash_engine');
      } else if (r.status === 'crashed' && statusRef.current === 'countdown') {
        // flash the FLEW AWAY state only while it's fresh (a new round starts
        // ~5s after the crash — window beyond that would be confusing)
        setStatus('crashed');
        setLiveCrashPoint(num(r.crashPoint, 1));
        setMultRawState(num(r.crashPoint, 1));
        crashedAtRef.current = performance.now();
      }
    });
    return () => {
      dead = true;
    };
  }, [prefix]);
  useEffect(() => {
    myBetRef.current = myBet;
  }, [myBet]);

  // DPR-aware canvas sizing (once + on resize)
  useEffect(() => {
    const fit = () => {
      const cv = canvasRef.current;
      if (!cv) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = cv.clientWidth * dpr;
      cv.height = cv.clientHeight * dpr;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // ── offline demo animation (unchanged dance, new skin) ─────────────────────
  useEffect(() => {
    if (!outcome || crashPoint <= 0) return;
    setStatus('flying');
    sound.play('crash_engine');
    const flyStart = performance.now();
    planeRef.current = { x: 30, y: 200 };
    const iv = setInterval(() => {
      const m = Math.max(
        1,
        Math.pow(Math.E, (0.06 * (performance.now() - flyStart)) / 1000)
      );
      lastTickRef.current = { m, at: performance.now() };
      growthRef.current = 0.00006;
      setMultRawState(m);
      if (m >= crashPoint) {
        clearInterval(iv);
        setStatus('crashed');
        crashedAtRef.current = performance.now();
        sound.stop('crash_engine');
        sound.play('crash_boom');
      }
    }, 50);
    return () => clearInterval(iv);
  }, [outcome, crashPoint]);

  // ── live socket feed (same events as before + new-bet for the board list) ──
  useEffect(() => {
    const onTick = (t: { multiplier?: number; elapsed?: number }) => {
      const m = num(t?.multiplier, 1);
      const now = performance.now();
      lastTickRef.current = { m, at: now };
      const el = num(t?.elapsed, 0);
      const g = inferCrashGrowth(m, el);
      if (g !== null) growthRef.current = g;
      if (!flightStartedAtRef.current && el > 0) flightStartedAtRef.current = now - el;
      else if (el > 0) {
        // smooth correction for clock drift
        flightStartedAtRef.current += ((now - el) - flightStartedAtRef.current) * 0.08;
      }
      if (now - lastPushRef.current > 500) {
        lastPushRef.current = now;
        setMultRawState(m);
      }
      if (statusRef.current !== 'flying') {
        if (!flightStartedAtRef.current) flightStartedAtRef.current = now - Math.max(0, el);
        setStatus('flying');
      }
    };
    const onStart = () => {
      setStatus('countdown');
      setMultRawState(0.1);
      lastTickRef.current = { m: 0.1, at: performance.now() };
      flightStartedAtRef.current = 0;
      shownMultRef.current = 1;
      setLiveCrashPoint(0);
      setLiveBets([]);
      setRows([]); // previous round's board clears when the next opens
      curveRef.current = [];
      crashedAtRef.current = 0;
      sound.play('bet_place');
    };
    const onCrash = (c: { crashPoint?: number }) => {
      const cp = num(c?.crashPoint, 1);
      setStatus('crashed');
      crashedAtRef.current = performance.now();
      lastTickRef.current = { m: cp, at: performance.now() };
      setMultRawState(cp);
      setLiveCrashPoint(cp);
      setHistory((h) => [cp, ...h].slice(0, 18));
      setRows((rs) => rs.map((r) => (r.cashed ? r : { ...r, busted: true })));
      sound.stop('crash_engine');
      sound.play('crash_boom');
      // v1.3.4: kill the riding-but-settled "your bet" chip — clearMyCrashBet
      // existed but was NEVER called, so the chip rode into every later round.
      clearMyCrashBet();
    };
    const onCashout = (c: { userId_masked?: string; amount?: number; at?: number }) => {
      const u = String(c?.userId_masked ?? 'Player');
      const pay = num(c?.amount, 0);
      const at = num(c?.at, 0);
      setRows((rs) => {
        // mark the first un-cashed row for this player as cashed
        const i = rs.findIndex((r) => r.user === u && !r.cashed && !r.busted);
        if (i < 0)
          return [
            {
              user: u,
              amount: pay / Math.max(1, at),
              payout: pay,
              at,
              cashed: true,
              busted: false,
            },
            ...rs,
          ].slice(0, 40);
        const next = rs.slice();
        const prevRow = next[i]!;
        next[i] = {
          user: prevRow.user,
          at,
          payout: pay,
          cashed: true,
          busted: false,
          amount: prevRow.amount || pay / Math.max(1, at),
        };
        return next;
      });
      setLiveBets((b) => [{ user: u, amount: pay, at }, ...b].slice(0, 12));
    };
    const onNewBet = (b: { userId_masked?: string; amount?: number }) => {
      const u = String(b?.userId_masked ?? 'Player');
      const amt = num(b?.amount, 0);
      setRows((rs) =>
        [{ user: u, amount: amt, cashed: false, busted: false }, ...rs].slice(0, 40)
      );
    };
    const onMyResult = (r: {
      result?: string;
      multiplier?: number;
      payout?: number;
    }) => {
      if (!r?.result) return;
      clearMyCrashBet(); // settled — the riding chip must not survive it
      setMyResults((h) =>
        [
          {
            result: String(r.result),
            multiplier: num(r.multiplier, 0),
            payout: num(r.payout, 0),
            at: Date.now(),
          },
          ...h,
        ].slice(0, 30)
      );
    };
    // The All-Bets rail + cashout feed are room-scoped broadcasts
    // (game:{slug}). Nothing previously put the client in that room — the
    // socket's 'connect' handler re-joins whatever `currentGame` says, so set
    // it here and joct' handler re-joins whatever `currentGame` says, so set
    // it here and join now (and leave on unmount). Without this, new-bet and
    // player-cashout events never reached ANY client.
    safeSession.set('currentGame', prefix);
    socket.emit('game:join', { slug: prefix });
    socket.on(`${prefix}:round-start`, onStart);
    socket.on(`${prefix}:tick`, onTick);
    socket.on(`${prefix}:crash`, onCrash);
    socket.on(`${prefix}:player-cashout`, onCashout);
    socket.on(`${prefix}:new-bet`, onNewBet);
    socket.on(`${prefix}:my-result`, onMyResult);
    return () => {
      socket.emit('game:leave', { slug: prefix });
      safeSession.set('currentGame', '');
      socket.off(`${prefix}:round-start`, onStart);
      socket.off(`${prefix}:tick`, onTick);
      socket.off(`${prefix}:crash`, onCrash);
      socket.off(`${prefix}:player-cashout`, onCashout);
      socket.off(`${prefix}:new-bet`, onNewBet);
      socket.off(`${prefix}:my-result`, onMyResult);
    };
  }, [prefix]);

  // ── canvas render loop — OPTIMIZED (60fps, time-based curve, DOM plane) ──
  useEffect(() => {
    let raf = 0;
    let glowCache: { w: number; h: number; st: string } | null = null;
    let glowGradient: CanvasGradient | null = null;
    // Detailed plane — restored canvas version (original visuals, no per-frame shadowBlur)
    const drawPlane = (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      angle: number,
      t: number,
      alpha = 1
    ) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.globalAlpha = alpha;
      const s = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.4;
      const pa = t * 0.05;
      ctx.beginPath();
      ctx.ellipse(20 * s, 0, 1.8 * s, 9 * s * (0.4 + 0.6 * Math.abs(Math.sin(pa))), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#c40027';
      ctx.beginPath();
      // @ts-ignore roundRect exists in canvas
      ctx.roundRect(-16 * s, -9 * s, 26 * s, 4.5 * s, 2);
      ctx.fill();
      ctx.fillStyle = LINE_RED;
      ctx.beginPath();
      ctx.moveTo(22 * s, 0);
      ctx.quadraticCurveTo(16 * s, -3.4 * s, -8 * s, -3.4 * s);
      ctx.lineTo(-18 * s, -5 * s);
      ctx.lineTo(-18 * s, 0);
      ctx.lineTo(-14 * s, 2.6 * s);
      ctx.quadraticCurveTo(2 * s, 4.6 * s, 16 * s, 2.4 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#d4002c';
      ctx.beginPath();
      // @ts-ignore
      ctx.roundRect(-12 * s, 2.2 * s, 22 * s, 3.6 * s, 2);
      ctx.fill();
      ctx.fillStyle = '#b00024';
      ctx.beginPath();
      // @ts-ignore
      ctx.roundRect(-21.5 * s, -2 * s, 7 * s, 2.6 * s, 1.3);
      ctx.fill();
      ctx.beginPath();
      // @ts-ignore
      ctx.roundRect(-21.5 * s, -7.6 * s, 3.4 * s, 5.4 * s, 1.6);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(4 * s, -1.6 * s, 1.9 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    };

    const render = () => {
      const cv = canvasRef.current;
      if (cv) {
        const ctx = cv.getContext('2d', { alpha: false })!;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const W = cv.width / dpr;
        const H = cv.height / dpr;
        // Only set transform when size changed (avoid per-frame reset cost)
        if (cv.width !== Math.round(cv.clientWidth * dpr) || cv.height !== Math.round(cv.clientHeight * dpr)) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        } else {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        const st = statusRef.current;
        const t = performance.now();

        // ---- smooth multiplier (extrapolated) ----
        const lt = lastTickRef.current;
        let est = lt.m;
        if (st === 'flying' && lt.at > 0) {
          est = Math.max(0.1, lt.m * Math.exp(growthRef.current * (t - lt.at)));
        }
        let shown = shownMultRef.current + (est - shownMultRef.current) * (est > shownMultRef.current ? 0.42 : 0.18);
        if (st === 'crashed') shown = lt.m;
        if (st === 'countdown') shown = 0.1;
        shownMultRef.current = shown;
        const mNow = shown;

        // ---- background (cached starfield drawn cheaply) ----
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, W, H);
        // subtle dust - static pattern via cheap rects (no per-frame allocations)
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        for (let i = 0; i < 18; i++) {
          const sx = ((i * 977) % Math.max(1, Math.floor(W))) + ((i * 7) % 9);
          const sy = ((i * 613) % Math.max(1, Math.floor(H))) + ((i * 3) % 7);
          ctx.fillRect(sx, sy, 1.3, 1.3);
        }
        // central glow - cached gradient recreation only on size/status change
        const glowKey = `${W}x${H}-${st}`;
        if (!glowCache || glowCache.w !== W || glowCache.h !== H || glowCache.st !== st) {
          const cxr = W / 2, cyr = H * 0.42;
          const glowR = Math.max(W, H) * 0.55;
          const g = ctx.createRadialGradient(cxr, cyr, 10, cxr, cyr, glowR);
          g.addColorStop(0, st === 'crashed' ? 'rgba(200,30,60,0.22)' : GLOW_PURPLE);
          g.addColorStop(0.5, 'rgba(90,20,160,0.14)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          glowCache = { w: W, h: H, st };
          glowGradient = g;
        }
        if (glowGradient) {
          ctx.fillStyle = glowGradient;
          ctx.fillRect(0, 0, W, H);
        }

        // ---- curve helpers ----
        const yFor = (m: number) => {
          const top = Math.max(1.5, mNow * 1.18);
          const axisMin = 0.1;
          return H - 30 - (Math.log(Math.max(axisMin, m) / axisMin) / Math.log(top / axisMin)) * (H - 110);
        };
        // Time-based curve sampling: no unbounded pts growth, constant work
        if (st === 'flying' || st === 'crashed') {
          const flightStart = flightStartedAtRef.current || (t - (lt.at ? t - lt.at : 0) - 200);
          const elapsed = Math.max(0, t - flightStart);
          const crashed = st === 'crashed';
          const fade = crashed ? Math.max(0.22, 1 - (t - crashedAtRef.current) / 1400) : 1;
          // Sample curve every ~16ms (~60 points for 4s flight) - smooth bezier-like
          const sampleStep = 32;
          const points: Array<{ x: number; y: number; m: number }> = [];
          const totalSpan = Math.max(200, elapsed);
          for (let e = 0; e <= elapsed; e += sampleStep) {
            const m = e < 2500
              ? 0.1 * Math.exp((Math.log(10) / 2500) * e) // taxi
              : Math.exp(growthRef.current * (e - 2500)); // climb
            const clampedM = Math.min(m, mNow);
            const x = 24 + (e / totalSpan) * (W - 64);
            const y = yFor(clampedM);
            points.push({ x, y, m: clampedM });
          }
          // Ensure last point at current multiplier
          if (points.length) {
            points[points.length - 1]!.y = yFor(mNow);
            points[points.length - 1]!.x = W - 40;
          }

          if (points.length > 1) {
            // fill under curve
            ctx.beginPath();
            ctx.moveTo(points[0]!.x, H - 26);
            for (const q of points) ctx.lineTo(q.x, q.y);
            ctx.lineTo(points[points.length - 1]!.x, H - 26);
            ctx.closePath();
            // cached linear gradient (no per-point shadow)
            const fill = ctx.createLinearGradient(0, 30, 0, H);
            fill.addColorStop(0, `rgba(226,0,47,${0.34 * fade})`);
            fill.addColorStop(1, 'rgba(226,0,47,0.04)');
            ctx.fillStyle = fill;
            ctx.fill();

            // curve stroke - no shadowBlur (expensive GPU flush), use soft outer stroke instead
            ctx.beginPath();
            points.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
            ctx.strokeStyle = `rgba(226,0,47,${0.95 * fade})`;
            ctx.lineWidth = 3.2;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke();
            // subtle glow via second slightly thicker translucent stroke (cheaper than shadowBlur)
            ctx.globalAlpha = 0.18 * fade;
            ctx.lineWidth = 7;
            ctx.stroke();
            ctx.globalAlpha = 1;

            // DOM plane positioning - hardware accelerated transform3d
            // Canvas plane (primary) + DOM plane (shadow)
            {
              const last = points[points.length - 1]!;
              const prev = points[Math.max(0, points.length - 4)]!;
              let angle = Math.atan2(last.y - prev.y, Math.max(1, last.x - prev.x));
              let px = last.x;
              let py = last.y;
              let pAlpha = 1;
              if (crashed) {
                const k = Math.min(1, (t - crashedAtRef.current) / 1100);
                px += k * k * W * 0.35;
                py -= k * H * 0.38;
                angle = -0.7;
                pAlpha = Math.max(0, 1 - k * 1.15);
              }
              // Draw detailed plane on canvas (restored visuals)
              drawPlane(ctx, px, py, crashed ? angle : angle * 0.85, t, pAlpha);
              // Also sync DOM plane for hardware-accelerated shadow on high-DPI
              if (planeDomRef.current) {
                planeDomRef.current.style.transform = `translate3d(${px}px, ${py}px, 0) rotate(${crashed ? angle : angle * 0.85}rad)`;
                planeDomRef.current.style.opacity = '0'; // canvas is primary, DOM hidden but kept for future
              }
              planeRef.current = { x: px, y: py };
            }
          }
        } else if (st === 'countdown') {
          const px = W * 0.16, py = H - 46;
          planeRef.current = { x: px, y: py };
          if (planeDomRef.current) {
            planeDomRef.current.style.transform = `translate3d(${px}px, ${py + Math.sin(t / 500) * 1.5}px, 0) rotate(-0.12rad)`;
            planeDomRef.current.style.opacity = '0';
          }
          ctx.strokeStyle = 'rgba(226,0,47,0.35)';
          ctx.lineWidth = 2;
          ctx.setLineDash([1, 9]);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(px + 26, py - 2);
          ctx.quadraticCurveTo(W * 0.55, H * 0.62, W * 0.86, H * 0.16);
          ctx.stroke();
          ctx.setLineDash([]);
          drawPlane(ctx, px, py + Math.sin(t / 500) * 2.2, -0.12, t);
        }

        // HUD — direct DOM, no React
        if (st === 'flying') {
          const tx = `${shown.toFixed(2)}x`;
          if (hudMainRef.current && hudMainRef.current.textContent !== tx) hudMainRef.current.textContent = tx;
          if (hudChipRef.current && hudChipRef.current.textContent !== tx) hudChipRef.current.textContent = tx;
        }
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  const my = myBet ?? myBetRef.current;
  const crashed = status === 'crashed';
  const cashedRows = rows.filter((r) => r.cashed);
  const topRows = [...cashedRows]
    .sort((a, b) => (b.payout ?? 0) - (a.payout ?? 0))
    .slice(0, 12);

  const BetsPanel = (
    <div
      className="flex flex-col h-full min-h-0 rounded-2xl overflow-hidden border border-white/10"
      style={{ background: PANEL }}
    >
      {/* tabs */}
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        {(
          [
            ['all', 'All Bets'],
            ['my', 'My Bets'],
            ['top', 'Top'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded-full text-[11px] font-black tracking-wide transition-colors ${
              tab === k ? 'bg-white/12 text-white' : 'text-white/45 hover:text-white/70'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'all' && (
        <div className="flex items-baseline justify-between px-3 py-1.5">
          <p className="text-[12px] font-black text-white tracking-widest">
            ALL BETS <span className="text-white/60">{rows.length || ''}</span>
          </p>
          <p className="text-[10px] text-white/35 font-bold">Previous hand ▾</p>
        </div>
      )}
      {tab !== 'all' && (
        <div className="px-3 py-1.5">
          <p className="text-[11px] font-black text-white/70 tracking-widest">
            {tab === 'my'
              ? `MY BETS ${myResults.length || ''}`
              : `TOP ${topRows.length || ''}`}
          </p>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1">
        {tab === 'all' &&
          (rows.length === 0 ? (
            <p className="text-[11px] text-white/30 px-2 py-3">
              Round bets appear here as players place them.
            </p>
          ) : (
            rows.map((r, i) => <BetRowView key={`${r.user}-${i}`} r={r} />)
          ))}
        {tab === 'my' &&
          (myResults.length === 0 ? (
            <p className="text-[11px] text-white/30 px-2 py-3">
              {user
                ? 'Your settles land here — cash out before the plane flies away.'
                : 'Log in to play.'}
            </p>
          ) : (
            myResults.map((r, i) => (
              <div
                key={i}
                className={`rounded-xl px-3 py-2 flex items-center justify-between border ${
                  r.result === 'CASHOUT'
                    ? 'bg-[#0f2c1c] border-[#1d5c39]'
                    : 'bg-[#2a1016] border-[#57171f]'
                }`}
              >
                <div>
                  <p className="text-[12px] font-black text-white">
                    {r.result === 'CASHOUT' ? 'Cashed out ✓' : 'Busted 💥'}
                  </p>
                  <p className="text-[10px] text-white/45 tabular-nums">
                    @ {r.multiplier ? r.multiplier.toFixed(2) : '—'}×
                  </p>
                </div>
                <p
                  className={`text-[13px] font-black tabular-nums ${
                    r.result === 'CASHOUT' ? 'text-[#2fd477]' : 'text-[#ff6b84]'
                  }`}
                >
                  ₨{MONEY(r.payout)}
                </p>
              </div>
            ))
          ))}
        {tab === 'top' &&
          (topRows.length === 0 ? (
            <p className="text-[11px] text-white/30 px-2 py-3">
              The biggest cashes of this session show up here.
            </p>
          ) : (
            topRows.map((r, i) => (
              <div
                key={i}
                className="rounded-xl px-3 py-2 flex items-center gap-2.5 bg-white/[0.03] border border-white/5"
              >
                <span className="text-[11px] font-black text-white/30 w-5">
                  #{i + 1}
                </span>
                <AvatarCircle name={r.user} size={26} />
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-bold text-white truncate">{r.user}</p>
                  <p className="text-[10px] text-white/40 tabular-nums">
                    ₨{MONEY(r.amount)} @ {r.at!.toFixed(2)}×
                  </p>
                </div>
                <p className="text-[12px] font-black text-[#2fd477] tabular-nums">
                  ₨{MONEY(r.payout ?? 0)}
                </p>
              </div>
            ))
          ))}
      </div>
    </div>
  );

  return (
    <div
      className="relative w-full h-full overflow-hidden select-none"
      style={{ background: BG }}
    >
      {/* history ticker — the strip every crash player reads first */}
      <div className="absolute top-2 left-2 right-2 lg:left-[292px] flex items-center gap-1.5 z-20">
        <span className="hidden sm:flex w-6 h-6 rounded-full bg-black/50 border border-white/15 items-center justify-center text-[10px] font-black text-white/80">
          H
        </span>
        <span className="hidden sm:flex w-6 h-6 rounded-full bg-black/50 border border-white/15 items-center justify-center text-[11px]">
          🎁
        </span>
        <div className="flex-1 flex gap-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_12px,black_calc(100%-18px),transparent)]">
          {history.map((h, i) => {
            const c = histHue(h);
            return (
              <span
                key={i}
                className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-black tabular-nums"
                style={{
                  color: c.fg,
                  background: c.bg,
                  textShadow: `0 0 8px ${c.fg}66`,
                }}
              >
                {h.toFixed(2)}x
              </span>
            );
          })}
          {history.length === 0 && (
            <span className="text-[10px] text-white/25 font-bold pl-1">
              crash history builds here round by round
            </span>
          )}
        </div>
      </div>

      {/* desktop: All-Bets side column (Spribe left rail) */}
      <div className="hidden lg:block absolute left-2 top-10 bottom-2 w-[280px] z-10">
        {BetsPanel}
      </div>

      {/* canvas fills everything (side panel floats above it on desktop) */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full lg:!w-auto lg:left-[288px] lg:right-0 will-change-transform"
        style={{ contain: 'paint' }}
      />
      {/* DOM plane — hardware-accelerated, no canvas draw per frame */}
      <div
        ref={planeDomRef}
        className="absolute top-0 left-0 lg:left-[288px] pointer-events-none will-change-transform overflow-visible"
        aria-hidden
        style={{
          zIndex: 12,
          contain: 'layout paint',
          width: 0,
          height: 0,
        }}
      >
        <div
          style={{
            width: 34,
            height: 18,
            marginLeft: -17,
            marginTop: -9,
            background: 'linear-gradient(90deg, #e2002f 0%, #c40027 100%)',
            borderRadius: 4,
            boxShadow: '0 2px 10px rgba(226,0,47,0.45)',
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              right: -6,
              top: '50%',
              marginTop: -2,
              width: 10,
              height: 4,
              background: '#fff',
              borderRadius: 2,
              opacity: 0.9,
            }}
          />
        </div>
      </div>

      {/* centre HUD — big multiplier over the purple glow */}
      <div className="absolute inset-0 lg:left-[288px] pointer-events-none flex flex-col items-center justify-center z-10">
        {status !== 'countdown' && !crashed && (
          <>
            <p
              ref={hudMainRef}
              className="tabular-nums text-white font-black"
              style={{
                fontSize: 'clamp(44px, 9vw, 96px)',
                lineHeight: 1,
                textShadow:
                  '0 0 28px rgba(255,255,255,0.35), 0 2px 14px rgba(0,0,0,0.5)',
              }}
            >
              {num(mult, 1).toFixed(2)}x
            </p>
            {my && (
              <p className="mt-1 px-3 py-1 rounded-full bg-black/55 border border-white/15 text-[11px] font-black text-white/80 tabular-nums">
                ₨{num(my.amount, 0)} riding @{' '}
                <span ref={hudChipRef}>{num(mult, 1).toFixed(2)}x</span>
              </p>
            )}
          </>
        )}
        {crashed && (
          <div className="text-center animate-pulse-once">
            <p className="text-white/75 font-black tracking-[0.22em] text-[15px]">
              FLEW AWAY!
            </p>
            <p
              className="tabular-nums font-black mt-1"
              style={{
                fontSize: 'clamp(38px, 8vw, 84px)',
                lineHeight: 1,
                color: '#ff4d5e',
                textShadow: '0 0 34px rgba(255,60,80,0.55)',
              }}
            >
              {num(shownCrash, 1).toFixed(2)}x
            </p>
          </div>
        )}
        {status === 'countdown' && (
          <div className="text-center">
            {countdownLeft > 0 ? (
              <p
                className="tabular-nums font-black text-white"
                style={{
                  fontSize: 'clamp(44px, 9vw, 96px)',
                  lineHeight: 1,
                  textShadow:
                    '0 0 28px rgba(255,255,255,0.35), 0 2px 14px rgba(0,0,0,0.5)',
                }}
              >
                {countdownLeft}
              </p>
            ) : null}
            <p
              className="font-black tracking-wide"
              style={{
                fontSize: 'clamp(22px, 4vw, 34px)',
                color: '#d9a8ff',
                textShadow: '0 0 26px rgba(150,60,255,0.6)',
              }}
            >
              Waiting for next round
            </p>
            {my && (
              <p className="mt-2 px-3 py-1 rounded-full bg-black/55 border border-[#2fb765]/50 text-[11px] font-black text-[#7ff0ad]">
                your ₨{num(my.amount, 0)} bet is in ✓ — good luck
              </p>
            )}
          </div>
        )}
      </div>

      {/* MY RESULT banners — server truth via {slug}:my-result (page props) */}
      {result === 'CASHOUT' && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-30 pointer-events-none lg:left-[calc(144px+50%)]">
          <div
            className="rounded-2xl px-6 py-3 text-center border border-[#2fd477]/60 shadow-[0_8px_40px_rgba(47,212,119,0.35)]"
            style={{ background: 'rgba(10,40,24,0.88)' }}
          >
            <p className="text-[#2fd477] font-black text-lg tracking-wide">
              CASHED OUT ✓
            </p>
            {(() => {
              const o = outcome as {
                multiplier?: number;
                payout?: number;
                joinMultiplier?: number;
              } | null;
              const m = o?.multiplier ?? 0;
              const p =
                Number(o?.payout ?? 0) ||
                (my ? Math.round(my.amount * m * 100) / 100 : 0);
              const joined = Number(o?.joinMultiplier ?? 1);
              return m ? (
                <>
                  <p className="text-white font-black tabular-nums text-xl">
                    ₨{MONEY(p)} @ {num(m, 0).toFixed(2)}x
                  </p>
                  {joined > 1.01 && (
                    <p className="text-[10px] text-white/50">
                      joined mid-flight at {joined.toFixed(2)}x
                    </p>
                  )}
                </>
              ) : null;
            })()}
          </div>
        </div>
      )}
      {result === 'BUST' && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-30 pointer-events-none lg:left-[calc(144px+50%)]">
          <div
            className="rounded-2xl px-6 py-3 text-center border border-[#ff4d5e]/50"
            style={{ background: 'rgba(45,8,14,0.85)' }}
          >
            <p className="text-[#ff6b84] font-black text-lg tracking-wide">BUSTED</p>
            <p className="text-white/60 font-bold tabular-nums text-sm">
              crashed before you cashed out
            </p>
          </div>
        </div>
      )}

      {/* mobile: cashout chips strip (side panel lives in a drawer on small screens) */}
      <div className="lg:hidden absolute bottom-2 left-2 right-2 pointer-events-none z-10">
        <div className="flex flex-wrap gap-1 justify-center">
          {liveBets.slice(0, 6).map((b, i) => (
            <span
              key={i}
              className="text-[10px] bg-black/45 rounded-full px-2 py-0.5 border border-white/10"
            >
              <span className="text-white/60">{b.user}</span>{' '}
              <span className="text-[#b05cff]">
                ₨{b.amount}
                {b.at ? ` @${num(b.at, 0).toFixed(2)}x` : ''}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* mobile: All-Bets drawer toggle */}
      <button
        onClick={() => setMobilePanel((v) => !v)}
        className="lg:hidden absolute right-2 top-10 z-30 px-2.5 h-8 rounded-full bg-black/60 border border-white/15 text-[11px] font-black text-white/80 backdrop-blur-sm"
      >
        👥 {rows.length || ''}
      </button>
      {mobilePanel && (
        <div
          className="lg:hidden absolute left-2 right-2 top-20 bottom-12 z-30"
          onClick={() => setMobilePanel(false)}
        >
          <div className="h-full" onClick={(e) => e.stopPropagation()}>
            {BetsPanel}
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulseOnceKf { 0% { opacity: 0; transform: scale(0.94) } 100% { opacity: 1; transform: scale(1) } }
        .animate-pulse-once { animation: pulseOnceKf 0.35s ease-out }
        @keyframes cashBTN { 0%,100% { box-shadow: 0 4px 22px rgba(242,153,58,0.45) } 50% { box-shadow: 0 4px 34px rgba(242,153,58,0.85) } }
        .animate-cashbtn { animation: cashBTN 1.4s ease-in-out infinite }
      `}</style>
    </div>
  );
}

const AvatarCircle = React.memo(function AvatarCircle({ name, size = 30 }: { name: string; size?: number }) {
  const a = avatarFor(name || '?');
  return (
    <span
      className="flex items-center justify-center rounded-full shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.52,
        background: `hsl(${a.hue} 55% 28%)`,
        border: `2px solid hsl(${a.hue} 70% 45%)`,
      }}
    >
      {a.emoji}
    </span>
  );
});

const BetRowView = React.memo(function BetRowView({ r }: { r: BetRow }) {
  return (
    <div
      className={`rounded-xl px-2.5 py-1.5 flex items-center gap-2.5 border ${
        r.cashed
          ? 'bg-[#0f2c1c] border-[#1d5c39]'
          : r.busted
            ? 'bg-white/[0.02] border-white/5 opacity-60'
            : 'bg-white/[0.04] border-white/8'
      }`}
    >
      <AvatarCircle name={r.user} />
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-bold text-white truncate">{r.user}</p>
      </div>
      <div className="text-right">
        <p className="text-[12px] font-black text-white tabular-nums leading-tight">
          ₨{MONEY(r.amount)}{' '}
          {r.cashed && r.at ? (
            <span
              className="ml-1 px-1.5 py-0.5 rounded-md text-[10px] font-black tabular-nums"
              style={{ background: 'rgba(176,92,255,0.22)', color: '#c996ff' }}
            >
              {r.at.toFixed(2)}x
            </span>
          ) : null}
        </p>
        <p
          className={`text-[11px] font-black tabular-nums leading-tight ${
            r.cashed ? 'text-[#2fd477]' : r.busted ? 'text-white/30' : 'text-white/25'
          }`}
        >
          {r.cashed
            ? MONEY(r.payout ?? r.amount * (r.at ?? 1))
            : r.busted
              ? '0.00 ✖'
              : '…'}
        </p>
      </div>
    </div>
  );
});

// ════════════════════════════════════════════════════════════════════════════
// BET PANEL — two independent Spribe slots (amount steppers, presets, BET /
// CASH OUT buttons, Bet/Auto tabs)
// ═════════════════════════════════════════════════════════════════════════════
type SlotPhase = 'idle' | 'pending' | 'queued' | 'live' | 'done';

function BetSlot({
  slot,
  prefix,
  onBet,
  minBet,
  maxBet,
  balance,
  otherLiveRef,
  ownLiveRef,
  restoreLive,
}: {
  slot: 0 | 1;
  prefix: string;
  onBet: (amount: number) => Promise<unknown> | unknown;
  minBet: number;
  maxBet?: number;
  balance: number;
  otherLiveRef: React.MutableRefObject<boolean>;
  ownLiveRef: React.MutableRefObject<boolean>;
  restoreLive?: {
    roundId: string;
    amount: string;
    joinMultiplier: number;
    status: string;
  } | null;
}) {
  // 2026-08-21 operator rule: no auto-BETTING anywhere — the Auto tab keeps
  // only the AUTO ESCAPE (auto cash-out) row, default OFF (as in the
  // reference screenshots).
  const [tab, setTab] = useState<'bet' | 'auto'>('bet');
  const [amount, setAmount] = useState(100);
  const [phase, setPhase] = useState<SlotPhase>('idle');
  const [liveMult, setLiveMult] = useState(0);
  const [roundStatus, setRoundStatus] = useState<'countdown' | 'flying' | 'crashed'>(
    'countdown'
  );
  const [joinAt, setJoinAt] = useState(1);
  const [cashedMult, setCashedMult] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [autoCash, setAutoCash] = useState(2);
  const [autoCashOn, setAutoCashOn] = useState(false);
  const phaseRef = useRef<SlotPhase>('idle');
  phaseRef.current = phase;
  const amountRef = useRef(amount);
  amountRef.current = amount;
  const otherLive = otherLiveRef;

  const clampAmount = (v: number) => {
    let n = Math.round(v);
    if (n < 1) n = 1;
    if (maxBet && maxBet > 0) n = Math.min(n, maxBet);
    return n;
  };

  // v1.3.4: re-attach a server-side LIVE bet after a page refresh — the
  // CASH OUT button (and the HUD chip) must survive F5.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !restoreLive) return;
    restoredRef.current = true;
    if (phaseRef.current !== 'idle') return; // user already acted this mount
    const amt = Number(restoreLive.amount);
    if (Number.isFinite(amt) && amt > 0) setAmount(Math.round(amt));
    setJoinAt(Math.max(1, restoreLive.joinMultiplier));
    setPhase('live');
    ownLiveRef.current = true;
    if (Number.isFinite(amt) && amt > 0) setMyCrashBet({ amount: amt });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreLive]);

  const cashOut = useCallback(() => {
    socket.emit(
      `${prefix}:cashout`,
      { roundId: 'current' },
      (r: { success?: boolean }) => {
        if (r?.success) sound.play('cashout');
      }
    );
  }, [prefix]);

  const place = useCallback(async () => {
    const amt = amountRef.current;
    // mid-flight join only works when NO slot already rides (page re-entry
    // guard skips otherwise) → queue for the next round, Spribe-style.
    if (phaseRef.current !== 'idle' && phaseRef.current !== 'queued') return;
    if (amt < minBet) {
      setNote(`min bet is ${minBet}`);
      return;
    }
    if (amt > balance) {
      setNote('not enough balance');
      return;
    }
    setNote(null);
    setPhase('pending');
    try {
      const res = (await onBet(amt)) as {
        status?: string;
        joinMultiplier?: number;
        roundId?: string;
      } | null;
      if (!res) {
        setPhase('idle');
        return; // page already surfaced the error toast
      }
      if (res.status === 'SKIPPED') {
        // another bet is live (probably the other slot) — queue for next round
        setPhase('queued');
        return;
      }
      if (res.status === 'PLACED') {
        setJoinAt(Math.max(1, num(res.joinMultiplier, 1)));
        setPhase('live');
        ownLiveRef.current = true;
        return;
      }
      setPhase('idle');
    } catch {
      setPhase('idle');
    }
  }, [onBet, minBet, balance, ownLiveRef]);

  // round feed for THIS slot (kept local so both slots stay independent)
  useEffect(() => {
    const onTick = (t: { multiplier?: number }) => {
      const m = num(t?.multiplier, 1);
      setLiveMult(m);
      setRoundStatus('flying');
      // client-side auto cash-out (Auto tab)
      if (
        phaseRef.current === 'live' &&
        autoCashOnRef.current &&
        m >= autoCashRef.current &&
        !cashingRef.current
      ) {
        cashingRef.current = true;
        cashOut();
      }
    };
    const onStart = () => {
      setLiveMult(0);
      setRoundStatus('countdown');
      cashingRef.current = false;
      // a locally-queued bet fires once the new betting window opens
      if (phaseRef.current === 'queued') {
        setTimeout(() => {
          if (phaseRef.current === 'queued') void place();
        }, 250);
      }
    };
    const onCrash = () => {
      setRoundStatus('crashed');
      setLiveMult(0);
      if (phaseRef.current === 'live') {
        setPhase('done');
        setCashedMult(0);
      }
      setTimeout(() => {
        if (phaseRef.current === 'done' || phaseRef.current === 'live') {
          setPhase('idle');
          ownLiveRef.current = false;
        }
      }, 2200);
    };
    const onMyResult = (r: { result?: string; multiplier?: number }) => {
      if (phaseRef.current === 'live') {
        setPhase('done');
        // A BUST my-result also carries `multiplier` (the crash point) —
        // only a CASHOUT is a win. Showing "CASHED x×" on a busted bet is
        // the exact says-X-did-Y bug class everywhere else we killed.
        setCashedMult(r?.result === 'CASHOUT' ? num(r?.multiplier, 0) : 0);
        ownLiveRef.current = false;
        setTimeout(() => {
          if (phaseRef.current === 'done') setPhase('idle');
        }, 2200);
      }
    };
    socket.on(`${prefix}:tick`, onTick);
    socket.on(`${prefix}:round-start`, onStart);
    socket.on(`${prefix}:crash`, onCrash);
    socket.on(`${prefix}:my-result`, onMyResult);
    return () => {
      socket.off(`${prefix}:tick`, onTick);
      socket.off(`${prefix}:round-start`, onStart);
      socket.off(`${prefix}:crash`, onCrash);
      socket.off(`${prefix}:my-result`, onMyResult);
    };
  }, [prefix, place, ownLiveRef]);

  const autoCashRef = useRef(autoCash);
  autoCashRef.current = autoCash;
  const autoCashOnRef = useRef(autoCashOn);
  autoCashOnRef.current = autoCashOn;
  const cashingRef = useRef(false);

  // big button copy
  let btnLabel: React.ReactNode;
  let btnStyle: React.CSSProperties;
  let btnDisabled = false;
  let btnAction: () => void = () => void place();
  const estPayout =
    phase === 'live' ? (amount * Math.max(1, liveMult)) / Math.max(1, joinAt) : 0;
  if (phase === 'idle') {
    const joinNow = roundStatus === 'flying' && !otherLive.current;
    btnLabel = (
      <>
        <span className="text-[15px]">{joinNow ? 'BET · JOIN NOW' : 'BET'}</span>
        <span className="text-[15px] tabular-nums">{MONEY(amount)}</span>
      </>
    );
    btnStyle = { background: BET_GREEN };
  } else if (phase === 'pending') {
    btnLabel = <span className="text-[13px] opacity-90">PLACING…</span>;
    btnStyle = { background: '#3a4150' };
    btnDisabled = true;
  } else if (phase === 'queued') {
    btnLabel = (
      <>
        <span className="text-[12px]">WAITING FOR</span>
        <span className="text-[12px]">NEXT ROUND ✈</span>
      </>
    );
    btnStyle = {
      background: 'transparent',
      border: '2px solid rgba(242,153,58,0.75)',
      color: '#ffb45f',
    };
    btnAction = () => setPhase('idle'); // tap = cancel the local queue
  } else if (phase === 'live') {
    if (roundStatus === 'flying') {
      btnLabel = (
        <>
          <span className="text-[12px] tracking-wide">CASH OUT</span>
          <span className="text-[15px] tabular-nums">
            {joinAt > 1.01 ? '≈ ' : ''}₨{MONEY(estPayout)}
          </span>
        </>
      );
      btnStyle = { background: CASH_ORANGE };
      btnAction = cashOut;
    } else {
      btnLabel = (
        <>
          <span className="text-[12px]">BET PLACED ✓</span>
          <span className="text-[11px] opacity-85">waiting for take-off…</span>
        </>
      );
      btnStyle = { background: '#2c6f47' };
      btnDisabled = true;
    }
  } else {
    btnLabel = (() => {
      const win = cashedMult > 0;
      return (
        <>
          <span className="text-[13px]">
            {win ? `CASHED ${cashedMult.toFixed(2)}x ✓` : 'BUSTED'}
          </span>
          <span className="text-[11px] opacity-85">next round soon…</span>
        </>
      );
    })();
    btnStyle = {
      background: cashedMult > 0 ? '#2fd477' : '#57171f',
      ...(cashedMult > 0 ? {} : { color: '#ff8f9e' }),
    };
    btnDisabled = true;
  }

  return (
    <div
      className="rounded-2xl p-1.5 flex flex-col gap-1.5 border border-white/10"
      style={{ background: PANEL }}
      data-testid={`aviator-slot-${slot}`}
    >
      {/* Bet / Auto tabs */}
      <div className="flex items-center gap-2 px-1">
        <div className="flex gap-1 bg-black/40 rounded-full p-0.5">
          {(['bet', 'auto'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-1 rounded-full text-[11px] font-black tracking-wider transition-colors ${
                tab === k ? 'bg-white/14 text-white' : 'text-white/40'
              }`}
            >
              {k === 'bet' ? 'Bet' : 'Auto'}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[9px] font-black text-white/25 tracking-widest">
          SLOT {slot + 1}
        </span>
      </div>

      <div className="flex gap-1.5 items-stretch">
        {/* amount stepper + presets */}
        <div className="flex flex-col gap-1.5 w-[128px] shrink-0">
          <div className="flex items-center justify-between bg-black/45 rounded-full px-1 py-1 border border-white/10">
            <button
              aria-label="decrease stake"
              onClick={() => setAmount((a) => clampAmount(a - 100))}
              className="w-7 h-7 rounded-full bg-white/10 text-white text-base font-black active:scale-90 transition-transform leading-none"
            >
              −
            </button>
            <span className="text-[13px] font-black text-white tabular-nums">
              {amount.toLocaleString()}
            </span>
            <button
              aria-label="increase stake"
              onClick={() => setAmount((a) => clampAmount(a + 100))}
              className="w-7 h-7 rounded-full bg-white/10 text-white text-base font-black active:scale-90 transition-transform leading-none"
            >
              +
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {[100, 200, 500, 1000].map((v) => (
              <button
                key={v}
                onClick={() => setAmount((a) => clampAmount(a + v))}
                className="rounded-full bg-black/45 border border-white/10 py-1 text-[9.5px] font-black text-white/70 active:bg-white/10 tabular-nums"
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        {/* the big button */}
        <button
          onClick={btnAction}
          disabled={btnDisabled}
          className={`flex-1 rounded-xl flex flex-col items-center justify-center gap-0.5 py-3 font-black text-white shadow-[0_4px_20px_rgba(0,0,0,0.4)] transition-transform ${
            btnDisabled ? 'opacity-90' : 'active:scale-[0.97]'
          } ${phase === 'live' && roundStatus === 'flying' ? 'animate-cashbtn' : ''}`}
          style={btnStyle}
          data-testid={`aviator-slot-${slot}-btn`}
        >
          {btnLabel}
        </button>
      </div>

      {/* Auto tab extras — 2026-08-21: no auto-BETTING anywhere, so this row
          is ONLY Auto Cash Out, default off (matches reference set 2). */}
      {tab === 'auto' && (
        <div className="flex items-center justify-between gap-2 px-1 pb-0.5">
          <span className="text-[10px] font-bold tracking-[0.14em] text-white/50">
            AUTO CASH OUT
          </span>
          <label className="flex items-center gap-1.5 text-[10px] font-bold text-white/60">
            <span
              onClick={() => setAutoCashOn((v) => !v)}
              className={`w-7 h-4 rounded-full relative transition-colors cursor-pointer ${autoCashOn ? 'bg-[#f2993a]' : 'bg-white/15'}`}
            >
              <span
                className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all"
                style={{ left: autoCashOn ? '14px' : '2px' }}
              />
            </span>
            <span
              className={`tabular-nums font-black ${autoCashOn ? 'text-white' : 'text-white/40'}`}
            >
              {autoCashOn ? 'on' : 'off'}
            </span>
            <input
              type="number"
              min={1.1}
              step={0.1}
              value={autoCash}
              onChange={(e) => setAutoCash(Math.max(1.1, num(e.target.value, 2)))}
              className="w-12 bg-black/50 border border-white/15 rounded-md text-[10px] text-white px-1 py-0.5 tabular-nums outline-none"
            />
            x
          </label>
        </div>
      )}
      {note && <p className="text-[10px] text-[#ff8f9e] font-bold px-1">{note}</p>}
    </div>
  );
}

export function AviatorBetPanel({
  onBet,
  minBet,
  balance,
  isLoading: _isLoading,
  slug,
  config,
}: GameBetPanelProps) {
  // Two INDEPENDENT slots. The page's own re-entry guard SKIPs any second bet
  // while one is in PLAYING limbo, and the server refuses two live bets per
  // user per round (GAME_007) — so when one slot is riding, the other slot's
  // bet queues locally and auto-enters the next round, exactly like Spribe's
  // "Waiting for next round" state.
  const prefix = slug ?? 'aviator';
  const slot0Live = useRef(false);
  const slot1Live = useRef(false);
  void _isLoading; // per-slot pending states replace the global gate here

  // v1.3.4 — REFRESH RESTORE. The server keeps your live shared-round bet in
  // PostgreSQL; the UI used to forget everything on reload, so a F5 with a
  // live bet left the plane flying, your money riding, and NO cash-out button
  // (the slot forgot it was live). Re-attach the live bet to slot 1 so the
  // CASH OUT control comes back exactly where you left it.
  const [restore, setRestore] = useState<{
    roundId: string;
    amount: string;
    joinMultiplier: number;
    status: string;
  } | null>(null);
  useEffect(() => {
    let dead = false;
    void fetchCrashState(prefix).then((st) => {
      if (!dead) setRestore(st?.myLive ?? null);
    });
    return () => {
      dead = true;
    };
  }, [prefix]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full pt-1">
      <BetSlot
        slot={0}
        prefix={prefix}
        onBet={onBet}
        minBet={minBet}
        maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
        balance={balance}
        otherLiveRef={slot1Live}
        ownLiveRef={slot0Live}
        restoreLive={restore}
      />
      <BetSlot
        slot={1}
        prefix={prefix}
        onBet={onBet}
        minBet={minBet}
        maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
        balance={balance}
        otherLiveRef={slot0Live}
        ownLiveRef={slot1Live}
      />
    </div>
  );
}
