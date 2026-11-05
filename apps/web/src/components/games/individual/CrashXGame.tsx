// apps/web/src/components/games/individual/CrashXGame.tsx
// ─────────────────────────────────────────────────────────────────────────────
// CRASH-X SKIN (operator reference set, 2026-08-21): the "rocket to space"
// design — same crash engine and socket protocol as Aviator (eventPrefix is the
// ONLY protocol difference), every surface re-skinned:
//
//   ┌───────────────────────────────────────────────────────────────────────┐
//   │ 3.13x  33.81x  1.58x  1.00x               (history strip, top-right)    │
//   ├─────────────────┬─────────────────────────────────────────────────────┤
//   │  User  Bet&X  Cash Out │   SATURN planet (top-left)                    │
//   │  🧑 p***5 1,000 2.00x 4,000 │        starfield                        │
//   │  …                │        15.70x   🚀  (rocket rides a            │
//   │                   │                      yellow→red trail)         │
//   │                   │   "Bang @ 16.69x"  (crash state, cyan)         │
//   ├─────────────────┴─────────────────────────────────────────────────────┤
//   │ [− 10 +] [AUTO ESCAPE off 2.00x] [   BET (Next Round)   ] (slot 1)   │
//   │ [− 10 +] [AUTO ESCAPE off 2.00x] [   BET (Next Round)   ] (slot 2)   │
//   └───────────────────────────────────────────────────────────────────────┘
//
// HARD CONSTRAINTS HONOURED (identical to AviatorGame.tsx — do not regress):
//  · every payload number passes num() before render.
//  · results shown are always server truth via {slug}:my-result.
//  · ONE live bet per user — second slot queues for the next round.
//  · operator decision 2026-08-21: NO auto-betting in any game. The Auto BET
//    toggle does not exist here; only AUTO ESCAPE (auto cash-out) remains.
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

// ── palette (deep-space violet) ──────────────────────────────────────────────
const BG = '#0b0d2a';
const PANEL = '#101232';
const RAIL = '#131537';
const BET_GREEN = '#22c55e';
const MONEY = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Every number rendered here comes off a socket payload, and the HUD calls
// .toFixed() on it every frame. A single missing/malformed field used to set
// state to undefined/null and the next render threw
//   TypeError: Cannot read properties of null (reading 'toFixed')
// which unmounts the whole game behind the error boundary — mid-round, with
// the player's money on the table. num() guarantees a finite number.
function num(v: unknown, fallback: number): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** Live multiplier + history chip colour from the reference: <2 magenta,
 *  2–9.99 cyan, ≥10 gold. (same three-band ladder on both surfaces) */
const BAND = {
  low: { fg: '#ff2ea6' }, // magenta
  mid: { fg: '#22d3ee' }, // cyan
  high: { fg: '#f5c842' }, // gold
} as const;
function band(m: number) {
  return m >= 10 ? BAND.high : m >= 2 ? BAND.mid : BAND.low;
}

/** deterministic emoji avatar + tint for a masked player label. */
const AVATARS = [
  '🧑‍🚀',
  '👩‍🚀',
  '👽',
  '🛸',
  '🌟',
  '🪐',
  '👾',
  '🌙',
  '⚡',
  '🎰',
  '🦾',
  '🌈',
];
function avatarFor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  h = Math.abs(h);
  return { emoji: AVATARS[h % AVATARS.length], hue: h % 360 };
}

/** mask a real phone/id for the public rail, like the reference (P***5). */
function maskUser(u: string): string {
  if (!u) return 'Player';
  if (/mask/i.test(u) || u.length <= 4) return u;
  return `${u[0]}***${u[u.length - 1]}`;
}

// ── one row in the player rail ───────────────────────────────────────────────
interface BetRow {
  user: string;
  amount: number;
  at?: number;
  payout?: number;
  cashed: boolean;
  busted: boolean;
  mine: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// VISUAL — space canvas + history strip + player rail
// ════════════════════════════════════════════════════════════════════════════
export function CrashXVisual({ outcome, result, eventPrefix }: GameVisualProps) {
  const prefix = eventPrefix ?? 'crash-x';
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const curveRef = useRef<Array<{ t: number; m: number }>>([]);
  const crashedAtRef = useRef(0);
  // ── smooth-flight model: server ticks at 100ms (a visible 10Hz staircase if
  // painted verbatim). Extrapolate between ticks at 60fps and re-anchor on
  // every real tick — the truth stays the server's number.
  const lastTickRef = useRef<{ m: number; at: number }>({ m: 1, at: 0 });
  const growthRef = useRef(0.00016);
  const shownMultRef = useRef(1);
  const hudMainRef = useRef<HTMLParagraphElement>(null);
  const planeXRef = useRef(60);
  const planeYRef = useRef(200);

  const [multRawState, setMultRawState] = useState(1.0);
  const [status, setStatus] = useState<'countdown' | 'flying' | 'crashed'>('countdown');
  const statusRef = useRef(status);
  statusRef.current = status;
  const mult = multRawState;
  const [countdown, setCountdown] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [rows, setRows] = useState<BetRow[]>([]);
  const [myBet, setMyBet] = useState<ReturnType<typeof getMyCrashBet>>(null);
  const myBetRef = useRef<ReturnType<typeof getMyCrashBet>>(null);
  const user = useAuthStore((s) => s.user);

  const crashPoint = num((outcome as { crashPoint?: number })?.crashPoint, 0);
  const [liveCrashPoint, setLiveCrashPoint] = useState(0);
  const shownCrash = liveCrashPoint || crashPoint;

  useEffect(() => onMyCrashBet(() => setMyBet(getMyCrashBet())), []);

  // v1.3.4 — JOIN/REFRESH SNAPSHOT (identical contract to Aviator): hydrate
  // round state + recent crash strip on mount instead of sitting on
  // "waiting for next round" until the current round ends.
  useEffect(() => {
    let dead = false;
    void fetchCrashState(prefix).then((st) => {
      if (dead || !st) return;
      if (st.recent.length) setHistory(st.recent.slice(0, 24));
      const r = st.round;
      if (!r) return;
      if (r.status === 'flying' && statusRef.current !== 'flying') {
        lastTickRef.current = { m: r.multiplier, at: performance.now() };
        setStatus('flying');
        sound.play('crash_engine');
      } else if (r.status === 'crashed' && statusRef.current === 'countdown') {
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
    // mark own rail row (reference: own row highlighted with magenta mult)
    setRows((rs) =>
      rs.map((r) =>
        user && r.user.endsWith((user.phone ?? '').slice(-1)) ? { ...r, mine: true } : r
      )
    );
  }, [myBet, user]);

  // DPR-aware canvas sizing
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

  // ── offline demo animation (same dance as aviator demo, rocket skin) ───────
  useEffect(() => {
    if (!outcome || crashPoint <= 0) return;
    setStatus('flying');
    sound.play('crash_engine');
    const flyStart = performance.now();
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

  // countdown seconds between rounds (round-start → takeoff ~5s window)
  useEffect(() => {
    if (status !== 'countdown') return;
    const started = performance.now();
    const iv = setInterval(() => {
      const left = Math.max(0, 5 - (performance.now() - started) / 1000);
      setCountdown(left);
    }, 50);
    return () => clearInterval(iv);
  }, [status]);

  // ── live socket feed (same protocol as aviator, prefix crash-x) ───────────
  useEffect(() => {
    const onTick = (t: { multiplier?: number; elapsed?: number }) => {
      const m = num(t?.multiplier, 1);
      const now = performance.now();
      lastTickRef.current = { m, at: now };
      const el = num(t?.elapsed, 0);
      if (el > 50 && m > 1) growthRef.current = Math.log(m) / el;
      setMultRawState((prev) => (now % 500 < 51 ? m : prev));
      if (statusRef.current !== 'flying') setStatus('flying');
    };
    const onStart = () => {
      setStatus('countdown');
      setMultRawState(0.1);
      lastTickRef.current = { m: 0.1, at: performance.now() };
      shownMultRef.current = 1;
      setLiveCrashPoint(0);
      setRows([]);
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
      setHistory((h) => [cp, ...h].slice(0, 24));
      setRows((rs) => rs.map((r) => (r.cashed ? r : { ...r, busted: true })));
      sound.stop('crash_engine');
      sound.play('crash_boom');
      clearMyCrashBet(); // v1.3.4 — settled rides must not ghost into later rounds
    };
    const onCashout = (c: { userId_masked?: string; amount?: number; at?: number }) => {
      const u = maskUser(String(c?.userId_masked ?? 'Player'));
      const pay = num(c?.amount, 0);
      const at = num(c?.at, 0);
      setRows((rs) => {
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
              mine: false,
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
          mine: prevRow.mine,
        };
        return next;
      });
    };
    const onNewBet = (b: { userId_masked?: string; amount?: number }) => {
      const u = maskUser(String(b?.userId_masked ?? 'Player'));
      const amt = num(b?.amount, 0);
      setRows((rs) =>
        [
          { user: u, amount: amt, cashed: false, busted: false, mine: false },
          ...rs,
        ].slice(0, 40)
      );
    };
    safeSession.set('currentGame', prefix);
    socket.emit('game:join', { slug: prefix });
    socket.on(`${prefix}:round-start`, onStart);
    socket.on(`${prefix}:tick`, onTick);
    socket.on(`${prefix}:crash`, onCrash);
    socket.on(`${prefix}:player-cashout`, onCashout);
    socket.on(`${prefix}:new-bet`, onNewBet);
    return () => {
      socket.emit('game:leave', { slug: prefix });
      safeSession.set('currentGame', '');
      socket.off(`${prefix}:round-start`, onStart);
      socket.off(`${prefix}:tick`, onTick);
      socket.off(`${prefix}:crash`, onCrash);
      socket.off(`${prefix}:player-cashout`, onCashout);
      socket.off(`${prefix}:new-bet`, onNewBet);
    };
  }, [prefix]);

  // ── canvas render loop — the space board ──────────────────────────────────
  useEffect(() => {
    let raf = 0;

    /** Saturn-style planet (top-left of the reference board). */
    const drawSaturn = (
      ctx: CanvasRenderingContext2D,
      cx: number,
      cy: number,
      r: number,
      tilt: number
    ) => {
      ctx.save();
      ctx.translate(cx, cy);
      // ring (back half)
      ctx.rotate(tilt);
      const grad = ctx.createRadialGradient(0, -r * 0.25, r * 0.05, 0, 0, r);
      grad.addColorStop(0, '#b8adff');
      grad.addColorStop(0.6, '#6d5fcd');
      grad.addColorStop(1, '#443a8f');
      // ring back
      ctx.strokeStyle = 'rgba(190,180,255,0.55)';
      ctx.lineWidth = r * 0.18;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.75, r * 0.45, 0, Math.PI, Math.PI * 2);
      ctx.stroke();
      // body
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      // soft shade
      ctx.fillStyle = 'rgba(10,10,40,0.25)';
      ctx.beginPath();
      ctx.arc(r * 0.28, r * 0.18, r * 0.95, 0, Math.PI * 2);
      ctx.fill();
      // ring front
      ctx.strokeStyle = 'rgba(210,205,255,0.75)';
      ctx.lineWidth = r * 0.14;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.75, r * 0.45, 0, 0, Math.PI);
      ctx.stroke();
      ctx.restore();
    };

    /** Earth-style planet (bottom-right of the reference board). */
    const drawEarth = (
      ctx: CanvasRenderingContext2D,
      cx: number,
      cy: number,
      r: number
    ) => {
      ctx.save();
      ctx.translate(cx, cy);
      const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
      grad.addColorStop(0, '#79c2ff');
      grad.addColorStop(0.55, '#2f6fd6');
      grad.addColorStop(1, '#123a86');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      // continents
      ctx.fillStyle = 'rgba(46,204,113,0.55)';
      ctx.beginPath();
      ctx.ellipse(-r * 0.25, -r * 0.25, r * 0.28, r * 0.16, 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(r * 0.2, r * 0.15, r * 0.22, r * 0.13, -0.4, 0, Math.PI * 2);
      ctx.fill();
      // glow rim
      ctx.strokeStyle = 'rgba(130,190,255,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r + 1.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    };

    /** the pink/white rocket from the reference skin. */
    const drawRocket = (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      angle: number,
      alpha = 1
    ) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle + Math.PI / 2); // rocket art points UP
      ctx.globalAlpha = alpha;
      // flame
      const fl = 14 + Math.sin(performance.now() / 60) * 3;
      const fg = ctx.createLinearGradient(0, 16, 0, 16 + fl + 14);
      fg.addColorStop(0, '#ffe38a');
      fg.addColorStop(0.5, '#ff9c3a');
      fg.addColorStop(1, 'rgba(255,80,20,0)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(-6, 16);
      ctx.quadraticCurveTo(0, 16 + fl + 16, 6, 16);
      ctx.closePath();
      ctx.fill();
      // body — magenta band, white capsule
      ctx.fillStyle = '#e6329b';
      ctx.beginPath();
      ctx.roundRect(-7, 2, 14, 16, 6);
      ctx.fill();
      ctx.fillStyle = '#f2e9ff';
      ctx.beginPath();
      ctx.moveTo(0, -20);
      ctx.quadraticCurveTo(9, -8, 7, 8);
      ctx.lineTo(-7, 8);
      ctx.quadraticCurveTo(-9, -8, 0, -20);
      ctx.closePath();
      ctx.fill();
      // nose tip
      ctx.fillStyle = '#ff5fb9';
      ctx.beginPath();
      ctx.moveTo(0, -20);
      ctx.quadraticCurveTo(5, -14, 6, -9);
      ctx.lineTo(-6, -9);
      ctx.quadraticCurveTo(-5, -14, 0, -20);
      ctx.closePath();
      ctx.fill();
      // window
      ctx.fillStyle = '#2d1b5e';
      ctx.beginPath();
      ctx.arc(0, -3, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.arc(-1, -4, 1.1, 0, Math.PI * 2);
      ctx.fill();
      // fins
      ctx.fillStyle = '#c91478';
      ctx.beginPath();
      ctx.moveTo(-7, 8);
      ctx.lineTo(-13, 18);
      ctx.lineTo(-7, 17);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(7, 8);
      ctx.lineTo(13, 18);
      ctx.lineTo(7, 17);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    };

    const render = () => {
      const cv = canvasRef.current;
      if (cv) {
        const ctx = cv.getContext('2d')!;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const W = cv.width / dpr;
        const H = cv.height / dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const st = statusRef.current;
        const t = performance.now();
        const lt = lastTickRef.current;
        let est = lt.m;
        if (st === 'flying' && lt.at > 0) {
          est = Math.max(1, lt.m * Math.exp(growthRef.current * (t - lt.at)));
        }
        let shown =
          shownMultRef.current +
          (est - shownMultRef.current) * (est > shownMultRef.current ? 0.42 : 0.18);
        if (st === 'crashed') shown = lt.m;
        if (st === 'countdown') shown = 1;
        shownMultRef.current = shown;
        const mNow = shown;
        if (st === 'flying') {
          curveRef.current.push({ t, m: shown });
          if (curveRef.current.length > 900) curveRef.current.shift();
        }

        // deep-space backdrop: vertical violet gradient
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#131047');
        bg.addColorStop(0.55, BG);
        bg.addColorStop(1, '#07081c');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
        // stars (two depths; twinkle for the near ones)
        for (let i = 0; i < 90; i++) {
          const par = (i % 3) * 0.35 + 0.65;
          const sx = ((i * 977) % Math.max(1, Math.floor(W))) + ((i * 7) % 9);
          let sy = ((i * 613) % Math.max(1, Math.floor(H))) + ((i * 3) % 7);
          sy = (sy + (st === 'flying' ? 0 : t * 0.004 * par)) % H;
          const tw = 0.45 + 0.55 * Math.abs(Math.sin(t / 900 + i));
          ctx.fillStyle = `rgba(255,255,255,${(i % 3 ? 0.5 : 0.3) * tw})`;
          const s = i % 7 === 0 ? 2.2 : i % 3 === 0 ? 1.5 : 1;
          ctx.fillRect(sx, sy, s, s);
        }
        // planets anchored like the reference: saturn top-left, earth bottom-right
        drawSaturn(ctx, W * 0.1, H * 0.14, Math.max(42, W * 0.045), -0.28);
        drawEarth(ctx, W * 0.86, H * 0.78, Math.max(64, W * 0.075));
        // faint axis grid (the reference shows a chart-ish background)
        ctx.strokeStyle = 'rgba(255,255,255,0.045)';
        ctx.lineWidth = 1;
        for (let gx = Math.floor(W / 7); gx < W; gx += Math.floor(W / 7)) {
          ctx.beginPath();
          ctx.moveTo(gx, 0);
          ctx.lineTo(gx, H);
          ctx.stroke();
        }

        const pts = curveRef.current;
        const yFor = (m: number) => {
          const top = Math.max(1.5, mNow * 1.18);
          // v1.3.7: log axis anchored at the 0.10x taxi floor so sub-1
          // climbs (and sub-1 crashes) are visible.
          const axisMin = 0.1;
          return (
            H -
            40 -
            (Math.log(Math.max(axisMin, m) / axisMin) / Math.log(top / axisMin)) *
              (H - 130)
          );
        };

        if (pts.length > 1 && (st === 'flying' || st === 'crashed')) {
          const t0 = pts[0]!.t;
          const span = Math.max(1, pts[pts.length - 1]!.t - t0);
          const xFor = (tt: number) => 30 + ((tt - t0) / span) * (W - 94);
          const crashed = st === 'crashed';
          const fade = crashed
            ? Math.max(0.3, 1 - (t - crashedAtRef.current) / 1600)
            : 1;

          if (!crashed) {
            // trail under the rocket: yellow → orange → red gradient line with
            // a soft fill below it (the reference's signature gradient streak).
            const head = pts[pts.length - 1]!;
            const grad = ctx.createLinearGradient(xFor(t0), 0, xFor(head.t), 0);
            grad.addColorStop(0, `rgba(255,225,90,${0.95})`);
            grad.addColorStop(0.55, `rgba(255,140,60,${0.95})`);
            grad.addColorStop(1, `rgba(255,45,80,${0.95})`);
            ctx.save();
            ctx.translate(0, 24); // the curve rides BELOW the rocket path
            ctx.beginPath();
            pts.forEach((q, i) =>
              i ? ctx.lineTo(xFor(q.t), yFor(q.m)) : ctx.moveTo(xFor(q.t), yFor(q.m))
            );
            ctx.strokeStyle = grad;
            ctx.lineWidth = 7;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.shadowColor = 'rgba(255,120,40,0.65)';
            ctx.shadowBlur = 20;
            ctx.stroke();
            ctx.shadowBlur = 0;
            // soft under-glow
            ctx.lineTo(xFor(pts[pts.length - 1]!.t), H);
            ctx.lineTo(xFor(pts[0]!.t), H);
            ctx.closePath();
            const fill = ctx.createLinearGradient(0, H * 0.2, 0, H);
            fill.addColorStop(0, 'rgba(255,150,50,0.16)');
            fill.addColorStop(1, 'rgba(255,60,90,0)');
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.restore();
          } else {
            // crash state: the trail vanishes (reference shows the board almost
            // empty under a "Bang @ x" banner) — scatter a few fading fragments.
            const k = Math.min(1, (t - crashedAtRef.current) / 1600);
            for (let i = 0; i < 14; i++) {
              const a = (i * 1.7) % (Math.PI * 2);
              const d = k * k * W * 0.12 + (i % 5) * 3;
              const fx = planeXRef.current + Math.cos(a) * d;
              const fy = planeYRef.current + Math.sin(a) * d * 0.6 - k * H * 0.1;
              ctx.fillStyle = `rgba(255,${80 + i * 8},40,${(1 - k) * 0.85})`;
              ctx.beginPath();
              ctx.arc(fx, fy, 2 + (i % 3), 0, Math.PI * 2);
              ctx.fill();
            }
          }

          const last = pts[pts.length - 1]!;
          let px = xFor(last.t);
          let py = yFor(last.m);
          const prev = pts[Math.max(0, pts.length - 8)]!;
          let angle = Math.atan2(py - yFor(prev.m), Math.max(1, px - xFor(prev.t)));
          let pAlpha = 1;
          if (crashed) {
            const k = Math.min(1, (t - crashedAtRef.current) / 1200);
            px += k * k * W * 0.42;
            py -= k * H * 0.42;
            angle = -0.75;
            pAlpha = Math.max(0, 1 - k * 1.3);
          }
          planeXRef.current = px;
          planeYRef.current = py;
          drawRocket(ctx, px, py, angle * 0.9, pAlpha * fade);
        } else if (st === 'countdown') {
          // parked rocket on its pad + countdown ring, like the reference
          // "New Round Starts in N.NN s" frame
          const px = W / 2,
            py = H * 0.42;
          // launch ring
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(px, py, 46, -Math.PI / 2, -Math.PI / 2 + (t / 5000) * Math.PI * 2);
          ctx.stroke();
          drawRocket(ctx, px, py + Math.sin(t / 450) * 3, 0, 1);
        }

        // HUD: live multiplier straight to DOM (React re-renders only rarely)
        if (st === 'flying' && hudMainRef.current) {
          const tx = `${shown.toFixed(2)}x`;
          if (hudMainRef.current.textContent !== tx)
            hudMainRef.current.textContent = tx;
          const bc = band(shown).fg;
          if (hudMainRef.current.style.color !== bc)
            hudMainRef.current.style.color = bc;
        }
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  const my = myBet ?? myBetRef.current;
  const crashed = status === 'crashed';

  return (
    <div
      className="relative w-full h-full overflow-hidden select-none"
      style={{ background: BG }}
    >
      {/* history strip — top-right, lays back oldest→newest like the reference */}
      <div className="absolute top-2 left-2 right-2 lg:left-[300px] flex items-center justify-end gap-1 z-20">
        <div className="flex gap-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_14px)]">
          {[...history].reverse().map((h, i) => (
            <span
              key={i}
              className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-black tabular-nums bg-black/40 border"
              style={{ color: band(h).fg, borderColor: `${band(h).fg}55` }}
            >
              {h.toFixed(2)}x
            </span>
          ))}
          {history.length === 0 && (
            <span className="text-[10px] text-white/25 font-bold pl-1">
              crash history builds here round by round
            </span>
          )}
        </div>
      </div>

      {/* desktop: the player rail (reference left column) */}
      <div
        className="hidden lg:flex absolute left-2 top-10 bottom-2 w-[286px] z-10 flex-col min-h-0 rounded-2xl overflow-hidden border border-white/10"
        style={{ background: RAIL }}
      >
        <div className="grid grid-cols-[1fr_68px_82px] px-3 py-2 border-b border-white/10">
          <p className="text-[11px] font-black text-white/80 tracking-wider">User</p>
          <p className="text-[11px] font-black text-white/80 tracking-wider text-right">
            Bet&amp;X
          </p>
          <p className="text-[11px] font-black text-white/80 tracking-wider text-right">
            Cash Out
          </p>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1.5 space-y-1">
          {rows.length === 0 ? (
            <p className="text-[11px] text-white/30 px-2 py-3">
              Round bets appear here as players place them.
            </p>
          ) : (
            rows.map((r, i) => <RailRow key={`${r.user}-${i}`} r={r} />)
          )}
        </div>
      </div>

      {/* canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full lg:!w-auto lg:left-[296px] lg:right-0"
      />

      {/* centre HUD */}
      <div className="absolute inset-0 lg:left-[296px] pointer-events-none flex flex-col items-center justify-center z-10">
        {status !== 'countdown' && !crashed && (
          <>
            <p
              ref={hudMainRef}
              className="tabular-nums font-black"
              style={{
                fontSize: 'clamp(44px, 9vw, 92px)',
                lineHeight: 1,
                color: band(num(mult, 1)).fg,
                textShadow:
                  '0 0 30px rgba(255,255,255,0.30), 0 2px 14px rgba(0,0,0,0.55)',
              }}
            >
              {num(mult, 1).toFixed(2)}x
            </p>
            {my && (
              <p className="mt-1 px-3 py-1 rounded-full bg-black/55 border border-white/15 text-[11px] font-black text-white/80 tabular-nums">
                ₨{num(my.amount, 0)} riding
              </p>
            )}
          </>
        )}
        {crashed && (
          <div className="text-center animate-pulse-once">
            <p
              className="font-black tracking-wide"
              style={{
                fontSize: 'clamp(30px, 6vw, 56px)',
                color: '#22d3ee',
                textShadow: '0 0 30px rgba(34,211,238,0.6)',
              }}
            >
              Bang @ {num(shownCrash, 1).toFixed(2)}x
            </p>
          </div>
        )}
        {status === 'countdown' && (
          <div className="text-center mt-24">
            <p
              className="font-black"
              style={{ fontSize: 'clamp(20px, 3.4vw, 30px)', color: '#22d3ee' }}
            >
              New Round Starts{' '}
              <span className="tabular-nums" style={{ color: '#f5c842' }}>
                in {countdown.toFixed(2)} s
              </span>
            </p>
            {/* countdown bar */}
            <div className="mt-3 h-1.5 w-64 max-w-[70vw] mx-auto rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-[#22d3ee]"
                style={{ width: `${(countdown / 5) * 100}%` }}
              />
            </div>
            {my && (
              <p className="mt-3 px-3 py-1 rounded-full bg-black/55 border border-[#22c55e]/50 text-[11px] font-black text-[#7ff0ad]">
                your ₨{num(my.amount, 0)} bet is in ✓ — good luck
              </p>
            )}
          </div>
        )}
      </div>

      {/* MY RESULT banners — server truth */}
      {result === 'CASHOUT' && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-30 pointer-events-none lg:left-[calc(148px+50%)]">
          <div
            className="rounded-2xl px-6 py-3 text-center border border-[#22c55e]/60 shadow-[0_8px_40px_rgba(34,197,94,0.35)]"
            style={{ background: 'rgba(10,40,24,0.88)' }}
          >
            <p className="text-[#4ade80] font-black text-lg tracking-wide">
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
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-30 pointer-events-none lg:left-[calc(148px+50%)]">
          <div
            className="rounded-2xl px-6 py-3 text-center border border-[#ff2ea6]/40"
            style={{ background: 'rgba(45,8,26,0.85)' }}
          >
            <p className="text-[#ff2ea6] font-black text-lg tracking-wide">BUSTED</p>
            <p className="text-white/60 font-bold tabular-nums text-sm">
              crashed before you cashed out
            </p>
          </div>
        </div>
      )}

      {/* mobile rail toggle */}
      <MobileRail rows={rows} />

      <style>{`
        @keyframes pulseOnceKf { 0% { opacity: 0; transform: scale(0.94) } 100% { opacity: 1; transform: scale(1) } }
        .animate-pulse-once { animation: pulseOnceKf 0.35s ease-out }
        @keyframes cashBTN { 0%,100% { box-shadow: 0 4px 22px rgba(242,153,58,0.45) } 50% { box-shadow: 0 4px 34px rgba(242,153,58,0.85) } }
        .animate-cashbtn { animation: cashBTN 1.4s ease-in-out infinite }
      `}</style>
    </div>
  );
}

function AvatarCircle({ name, size = 34 }: { name: string; size?: number }) {
  const a = avatarFor(name || '?');
  return (
    <span
      className="flex items-center justify-center rounded-full shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        background: `hsl(${a.hue} 55% 24%)`,
        border: `2px solid hsl(${a.hue} 70% 48%)`,
      }}
    >
      {a.emoji}
    </span>
  );
}

function RailRow({ r }: { r: BetRow }) {
  const mult = r.cashed && r.at ? r.at : null;
  return (
    <div
      className={`rounded-xl px-2 py-1.5 grid grid-cols-[36px_1fr_64px_78px] items-center gap-1.5 border ${
        r.cashed
          ? r.mine
            ? 'bg-[#2b0a22] border-[#ff2ea6]/40'
            : 'bg-[#0a2c1a] border-[#14532d]'
          : r.busted
            ? 'bg-white/[0.02] border-white/5 opacity-60'
            : 'bg-white/[0.03] border-white/8'
      }`}
    >
      <AvatarCircle name={r.user} size={28} />
      <p className="text-[11px] font-bold text-white truncate">{r.user}</p>
      <div className="text-right">
        <p className="text-[11px] font-black text-white tabular-nums leading-tight">
          ₨{MONEY(r.amount)}
        </p>
        {mult ? (
          <p
            className="text-[10px] font-black tabular-nums leading-tight"
            style={{ color: r.mine ? '#ff2ea6' : '#4ade80' }}
          >
            {mult.toFixed(2)}x
          </p>
        ) : null}
      </div>
      <p
        className={`text-[11px] font-black tabular-nums text-right ${
          r.cashed ? 'text-[#4ade80]' : r.busted ? 'text-white/30' : 'text-white/40'
        }`}
      >
        {r.cashed ? MONEY(r.payout ?? r.amount * (mult ?? 1)) : ''}
      </p>
    </div>
  );
}

function MobileRail({ rows }: { rows: BetRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="lg:hidden absolute right-2 top-10 z-30 px-2.5 h-8 rounded-full bg-black/60 border border-white/15 text-[11px] font-black text-white/80 backdrop-blur-sm"
      >
        👥 {rows.length || ''}
      </button>
      {open && (
        <div
          className="lg:hidden absolute left-2 right-2 top-20 bottom-12 z-30 flex flex-col min-h-0 rounded-2xl overflow-hidden border border-white/10"
          style={{ background: RAIL }}
          onClick={() => setOpen(false)}
        >
          <div className="grid grid-cols-[1fr_68px_82px] px-3 py-2 border-b border-white/10">
            <p className="text-[11px] font-black text-white/80 tracking-wider">User</p>
            <p className="text-[11px] font-black text-white/80 tracking-wider text-right">
              Bet&amp;X
            </p>
            <p className="text-[11px] font-black text-white/80 tracking-wider text-right">
              Cash Out
            </p>
          </div>
          <div
            className="flex-1 min-h-0 overflow-y-auto px-2 py-1.5 space-y-1"
            onClick={(e) => e.stopPropagation()}
          >
            {rows.map((r, i) => (
              <RailRow key={`${r.user}-${i}`} r={r} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// BET PANEL — two independent slots. Reference design: − N + stepper, big
// green "BET (Next Round)" button, AUTO ESCAPE toggle (NO auto-bet anywhere).
// ════════════════════════════════════════════════════════════════════════════
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
  const [amount, setAmount] = useState(10);
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

  // v1.3.4: re-attach a server-side LIVE bet after a page refresh.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !restoreLive) return;
    restoredRef.current = true;
    if (phaseRef.current !== 'idle') return;
    const amt = Number(restoreLive.amount);
    if (Number.isFinite(amt) && amt > 0) setAmount(Math.round(amt));
    setJoinAt(Math.max(1, restoreLive.joinMultiplier));
    setPhase('live');
    ownLiveRef.current = true;
    if (Number.isFinite(amt) && amt > 0) setMyCrashBet({ amount: amt });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreLive]);
  const amountRef = useRef(amount);
  amountRef.current = amount;
  const otherLive = otherLiveRef;

  const clampAmount = (v: number) => {
    let n = Math.round(v);
    if (n < 1) n = 1;
    if (maxBet && maxBet > 0) n = Math.min(n, maxBet);
    return n;
  };

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
        return;
      }
      if (res.status === 'SKIPPED') {
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

  const autoCashRef = useRef(autoCash);
  autoCashRef.current = autoCash;
  const autoCashOnRef = useRef(autoCashOn);
  autoCashOnRef.current = autoCashOn;
  const cashingRef = useRef(false);

  useEffect(() => {
    const onTick = (t: { multiplier?: number }) => {
      const m = num(t?.multiplier, 1);
      setLiveMult(m);
      setRoundStatus('flying');
      // client-side AUTO ESCAPE (auto cash-out; there is NO auto-bet anywhere)
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
      if (r?.result) clearMyCrashBet(); // v1.3.4 — settled, drop the riding chip
      if (phaseRef.current === 'live') {
        setPhase('done');
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
        <span className="text-[16px]">BET</span>
        <span className="text-[11px] opacity-85">
          ({joinNow ? 'Join Now' : 'Next Round'})
        </span>
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
        <span className="text-[12px]">BET (Next Round)</span>
        <span className="text-[10px] opacity-75">tap to cancel</span>
      </>
    );
    btnStyle = {
      background: 'transparent',
      border: '2px solid rgba(34,197,94,0.65)',
      color: '#4ade80',
    };
    btnAction = () => setPhase('idle');
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
      btnStyle = { background: '#f2993a' };
      btnAction = cashOut;
    } else {
      btnLabel = (
        <>
          <span className="text-[12px]">BET PLACED ✓</span>
          <span className="text-[10px] opacity-85">waiting for take-off…</span>
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
          <span className="text-[10px] opacity-85">next round soon…</span>
        </>
      );
    })();
    btnStyle = {
      background: cashedMult > 0 ? '#22c55e' : '#57171f',
      ...(cashedMult > 0 ? {} : { color: '#ff8fb0' }),
    };
    btnDisabled = true;
  }

  return (
    <div
      className="rounded-2xl p-2 flex flex-col gap-2 border border-white/10"
      style={{ background: PANEL }}
      data-testid={`crashx-slot-${slot}`}
    >
      {/* amount stepper (reference: − 10 + , "YOUR BET" label above) */}
      <div className="flex flex-col items-center gap-0.5">
        <p className="text-[9px] font-black tracking-[0.2em] text-white/45">YOUR BET</p>
        <div className="flex items-center justify-between w-full bg-black/45 rounded-full px-1 py-1 border border-white/10">
          <button
            aria-label="decrease stake"
            onClick={() => setAmount((a) => clampAmount(a - 10))}
            className="w-7 h-7 rounded-full bg-white/10 text-white text-base font-black active:scale-90 transition-transform leading-none"
          >
            −
          </button>
          <span className="text-[14px] font-black text-white tabular-nums">
            {amount.toLocaleString()}
          </span>
          <button
            aria-label="increase stake"
            onClick={() => setAmount((a) => clampAmount(a + 10))}
            className="w-7 h-7 rounded-full bg-white/10 text-white text-base font-black active:scale-90 transition-transform leading-none"
          >
            +
          </button>
        </div>
      </div>

      {/* AUTO ESCAPE (auto cash-out) — the only automation the operator allows */}
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-[9px] font-black tracking-[0.18em] text-white/45">
          AUTO ESCAPE
        </p>
        <div className="flex items-center gap-1.5">
          <span
            onClick={() => setAutoCashOn((v) => !v)}
            className={`w-8 h-4 rounded-full relative transition-colors cursor-pointer ${autoCashOn ? 'bg-[#22c55e]' : 'bg-white/15'}`}
          >
            <span
              className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all"
              style={{ left: autoCashOn ? '15px' : '2px' }}
            />
          </span>
          <span
            className={`text-[10px] font-black tabular-nums ${autoCashOn ? 'text-white' : 'text-white/45'}`}
          >
            {autoCashOn ? 'on' : 'off'}
          </span>
        </div>
        <div className={`flex items-center gap-1 ${autoCashOn ? '' : 'opacity-45'}`}>
          <input
            type="number"
            min={1.1}
            step={0.1}
            value={autoCash}
            onChange={(e) => setAutoCash(Math.max(1.1, num(e.target.value, 2)))}
            className="w-12 bg-black/50 border border-white/15 rounded-md text-[10px] text-white px-1 py-0.5 tabular-nums outline-none"
          />
          <span className="text-[10px] font-black text-white/60">x</span>
        </div>
      </div>

      {/* the big button */}
      <button
        onClick={btnAction}
        disabled={btnDisabled}
        className={`w-full rounded-xl flex flex-col items-center justify-center gap-0.5 py-3.5 font-black text-white shadow-[0_4px_20px_rgba(0,0,0,0.4)] transition-transform ${btnDisabled ? 'opacity-90' : 'active:scale-[0.97]'} ${phase === 'live' && roundStatus === 'flying' ? 'animate-cashbtn' : ''}`}
        style={btnStyle}
        data-testid={`crashx-slot-${slot}-btn`}
      >
        {btnLabel}
      </button>
      {note && <p className="text-[10px] text-[#ff8fb0] font-bold px-1">{note}</p>}
    </div>
  );
}

export function CrashXBetPanel({
  onBet,
  minBet,
  balance,
  isLoading: _isLoading,
  slug,
  config,
}: GameBetPanelProps) {
  const prefix = slug ?? 'crash-x';
  const slot0Live = useRef(false);
  const slot1Live = useRef(false);
  void _isLoading;

  // v1.3.4 — REFRESH RESTORE: re-attach my live shared-round bet so the
  // CASH OUT control survives a page reload (same contract as Aviator).
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
