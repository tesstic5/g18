// apps/web/src/components/games/game-kit.tsx — shared modern visual kit for ALL 20 games (D-069)
// Consistent design language: glass panels, glow, animated result banners + confetti,
// big displays, action tiles, count-up numbers. Every game visual uses these.
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { sound } from '../../lib/sound';
import type { RoundResult } from './types';

// ── THEME ─────────────────────────────────────────────────────────────────
export const GOLD = '#f5c842';
export const GREEN = '#00d97e';
export const RED = '#ff3b5c';
export const BLUE = '#4d9fff';
export const VIOLET = '#9b59ff';

// ── BACKDROP — animated layered background per game ───────────────────────
export function GameBackdrop({
  accent = GOLD,
  children,
  className = '',
  fit = true,
}: {
  accent?: string;
  children?: React.ReactNode;
  className?: string;
  /**
   * Scale the board down to fit the canvas (default) or let it keep full size
   * and scroll.
   *
   * Shrinking is right for most boards, but a game whose natural height is far
   * beyond the canvas gets scaled so far that its controls stop being usable:
   * roulette needs 740px in a 449px canvas, so it rendered at 0.607 and every
   * number cell came out 19-22px tall against a 32px minimum. Below about 0.75
   * you are no longer fitting a board, you are making it unhittable — those
   * games are better off full size with a scroll.
   */
  fit?: boolean;
}) {
  return (
    <div
      className={`relative w-full h-full overflow-hidden ${className}`}
      style={{
        background:
          'radial-gradient(130% 100% at 50% 0%, rgba(245,200,66,0.09), transparent 55%), radial-gradient(90% 70% at 88% 100%, rgba(77,159,255,0.08), transparent 60%), linear-gradient(165deg, #14141f 0%, #0b0b13 100%)',
      }}
    >
      {/* grid */}
      <div
        className="absolute inset-0 opacity-30"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
          backgroundSize: '34px 34px',
        }}
      />
      {/* orbs */}
      <div
        className="absolute -top-14 -left-14 w-52 h-52 rounded-full blur-[70px] animate-float-slow"
        style={{ background: `${accent}18` }}
      />
      <div
        className="absolute -bottom-16 -right-10 w-60 h-60 rounded-full blur-[80px] animate-float-slower"
        style={{ background: `${BLUE}14` }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        {fit ? (
          <FitToCanvas>{children}</FitToCanvas>
        ) : (
          <div data-fit-board="" className="w-full h-full overflow-y-auto">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

// ── FIT-TO-CANVAS ─────────────────────────────────────────────────────────
/**
 * "Some games elements are not fitting in properly."
 *
 * Every game board is wrapped in `overflow-y-auto` with a `min-h-full` child,
 * so whenever the board was taller than the canvas the surplus turned into a
 * SCROLLBAR. Measured on a 420x640 phone, this much of each board sat below
 * the fold:
 *
 *     roulette 259px · scratch-card 186px · tower 133px · lucky-number 96px
 *     mines 92px · wheel 84px · ring 66px · coin-flip 50px · keno 48px
 *
 * Scrolling is the wrong behaviour for a game board: the player taps PLAY and
 * the wheel they just paid to watch is off-screen. It also defeats the whole
 * point of the 100dvh viewport lock.
 *
 * So: shrink the board to fit instead of hiding part of it. A single uniform
 * CSS scale keeps every proportion intact — the board is simply smaller on a
 * short phone and full size on a tall one. Below 0.62 text stops being legible,
 * so past that floor we stop shrinking and allow scrolling as the last resort.
 *
 * This lives in GameBackdrop because all 17 board games already render through
 * it, so every one of them gets the behaviour without touching its markup.
 */
// 0.52 is the measured floor: roulette (the tallest board — wheel + full
// betting table) needs 0.55 to fit a 420x640 phone, and at that size its
// number labels are still legible. Anything below this and we stop shrinking,
// because unreadable is worse than scrollable.
const MIN_FIT_SCALE = 0.5;

export function FitToCanvas({ children }: { children?: React.ReactNode }) {
  const outer = useRef<HTMLDivElement | null>(null);
  const inner = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  /** the board's natural (unscaled) height in px, 0 until first measured */
  const [natural, setNatural] = useState(0);

  useEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;

    const measure = () => {
      const availH = o.clientHeight;
      const availW = o.clientWidth;
      if (availH <= 0 || availW <= 0) return;

      // Measure the board's NATURAL height, with no scale in play.
      //
      // This has to be done carefully. The sizing box used to be (100/scale)%
      // tall so that it landed on the canvas after the transform — but that
      // makes its height a function of the scale, so reading scrollHeight while
      // it was applied fed straight back into the next calculation. Roulette
      // collapsed to the 0.5 floor and sat marooned in an empty canvas.
      //
      // The loop is broken by always measuring in the SAME known state: full
      // canvas width, height:auto, no transform. That reading depends only on
      // the content, never on what we last did to it.
      const prevW = i.style.width;
      const prevH = i.style.height;
      const prevT = i.style.transform;
      i.style.width = `${availW}px`;
      i.style.height = 'auto';
      i.style.transform = 'none';
      const needH = i.scrollHeight;
      i.style.width = prevW;
      i.style.height = prevH;
      i.style.transform = prevT;

      if (needH <= 0) return;
      const next = Math.max(MIN_FIT_SCALE, Math.min(1, availH / needH));
      setScale((prev) => (Math.abs(next - prev) < 0.006 ? prev : next));
      setNatural((prev) => (Math.abs(needH - prev) < 2 ? prev : needH));
    };

    measure();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(o);
    ro?.observe(i);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
    };
  }, [children]);

  return (
    <div
      ref={outer}
      className="w-full h-full flex items-center justify-center overflow-hidden"
    >
      <div
        ref={inner}
        data-fit-board=""
        style={{
          // Width stays 100% of the canvas and the box is given its own
          // NATURAL height, so the scale shrinks a correctly-laid-out board
          // rather than one that was already distorted to fit.
          width: '100%',
          height: natural > 0 ? `${natural}px` : '100%',
          transform: scale < 1 ? `scale(${scale})` : undefined,
          transformOrigin: 'center center',
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ── RESULT BANNER — big animated WIN/LOSE/CASHOUT + confetti ──────────────
/**
 * `partialRefund` (Keno, Plinko, Lucky Number): the round LOST -- less came back
 * than went in -- but it was not a total loss. Those games have buckets that pay
 * e.g. 0.24x, and a bare "YOU LOSE" made the returned money look like a bug
 * ("my balance went up but it says I lost"). The banner now says so explicitly.
 */
export function ResultBanner({
  result,
  multiplier,
  payout,
  accent,
  partialRefund,
  ready = true,
  holdMs = 2600,
  roundKey,
}: {
  result: 'WIN' | 'LOSE' | 'CASHOUT' | 'BUST' | 'PUSH' | null;
  multiplier?: number;
  payout?: number;
  accent?: string;
  partialRefund?: boolean;
  /**
   * Gate: the banner only appears once the game's own animation has finished.
   *
   * Without this the banner fired the instant the server response arrived
   * (~1.5s after the tap) while the board was still mid-animation — the wheel
   * takes 4.2s to stop and Keno 4.4s to draw, so the game announced the answer
   * seconds before it had finished playing.
   */
  ready?: boolean;
  /** how long the banner stays on screen */
  holdMs?: number;
  /**
   * Identifies WHICH round this verdict belongs to.
   *
   * The de-duplication key used to be `result-multiplier-payout`, so two
   * consecutive rounds with an identical outcome — losing 10 twice in a row,
   * which happens constantly — produced the same key and the banner was
   * suppressed on the second one. Measured: round 1 showed a verdict, rounds 2
   * and 3 showed nothing at all on most games. Including the round number makes
   * every round distinct.
   */
  roundKey?: number;
}) {
  // Store the exact verdict key that was allowed to become visible. There is a
  // single effect: the previous implementation had a "show" effect followed by
  // a "new round: hide" effect in the same commit, so React batched true→false
  // and the shipped consecutive-round regression test failed.
  const [visibleKey, setVisibleKey] = useState<string | null>(null);
  const key = result
    ? `${roundKey ?? 'implicit'}-${result}-${multiplier ?? ''}-${payout ?? ''}`
    : null;

  useEffect(() => {
    if (!result || !ready || !key) {
      setVisibleKey(null);
      return;
    }
    setVisibleKey(key);
    if (result === 'WIN' || result === 'CASHOUT') {
      sound.play(payout && payout >= 500 ? 'win_big' : 'win');
    } else if (result === 'PUSH') {
      sound.play('cashout');
    } else {
      sound.play('lose');
    }
    const timer = setTimeout(
      () => setVisibleKey((shown) => (shown === key ? null : shown)),
      holdMs
    );
    return () => clearTimeout(timer);
  }, [result, multiplier, payout, ready, holdMs, roundKey, key]);

  // Render-time guards hide an old verdict immediately when a parent clears the
  // result or starts a non-revealed round; no effect-frame can leak it.
  if (!result || !ready || !key || visibleKey !== key) return null;
  const win = result === 'WIN' || result === 'CASHOUT';
  const push = result === 'PUSH';
  const color = win ? (accent ?? GREEN) : push ? GOLD : RED;

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none px-4"
      role="status"
      aria-live="polite"
    >
      {win && <Confetti />}
      {/*
        The verdict sits on a dark plate.

        It used to be bare glowing text tinted with the GAME'S OWN accent
        colour. On Wheel of Fortune that is gold — printed straight over a
        mostly-gold spinning wheel, so the single most important frame in the
        game ("YOU WIN! 1.92x") was yellow-on-yellow and genuinely unreadable.
        Ring of Fortune and Lucky Number had the same clash.

        A translucent dark backing plate guarantees contrast on every board,
        whatever colour the art underneath happens to be.
      */}
      <div
        className="text-center animate-banner-pop rounded-2xl px-6 py-4 backdrop-blur-md"
        style={{
          background: 'rgba(8,8,14,0.82)',
          border: `1px solid ${color}55`,
          boxShadow: `0 10px 40px rgba(0,0,0,0.6), 0 0 30px ${color}33`,
        }}
      >
        <p
          className="text-4xl sm:text-6xl font-black uppercase tracking-wider animate-banner-glow leading-none"
          style={{
            color,
            textShadow: `0 2px 12px rgba(0,0,0,0.9), 0 0 30px ${color}88`,
            fontFamily: 'inherit',
          }}
        >
          {result === 'CASHOUT'
            ? 'CASHED OUT!'
            : result === 'PUSH'
              ? 'BET RETURNED'
              : win
                ? 'YOU WIN!'
                : partialRefund
                  ? 'PART BACK'
                  : 'YOU LOSE'}
        </p>
        {win && multiplier !== undefined && (
          <p className="t-headline text-white mt-1.5 animate-spring-in">
            {multiplier.toFixed(2)}×
            {payout !== undefined ? ` · ₨${payout.toLocaleString()}` : ''}
          </p>
        )}
        {push && multiplier !== undefined && (
          <p className="t-headline text-white/80 mt-1.5 animate-spring-in">
            {multiplier.toFixed(2)}× returned
            {payout !== undefined ? ` · ₨${payout.toLocaleString()}` : ''}
          </p>
        )}
        {!win && !push && partialRefund && multiplier !== undefined && (
          <p className="t-headline text-white/80 mt-1.5 animate-spring-in">
            {multiplier.toFixed(2)}× returned
            {payout !== undefined ? ` · ₨${payout.toLocaleString()}` : ''}
          </p>
        )}
      </div>
      <style>{`
        @keyframes bannerPop { 0% { transform: scale(0.3); opacity: 0 } 55% { transform: scale(1.12); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
        .animate-banner-pop { animation: bannerPop 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.4) forwards }
        @keyframes bannerGlow { 0%, 100% { opacity: 1 } 50% { opacity: 0.75 } }
        .animate-banner-glow { animation: bannerGlow 1.4s ease-in-out infinite }
      `}</style>
    </div>
  );
}

// ── CONFETTI — lightweight canvas confetti burst ──────────────────────────
export function Confetti({ count = 90 }: { count?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const W = (cv.width = cv.offsetWidth * 2);
    const H = (cv.height = cv.offsetHeight * 2);
    const colors = ['#f5c842', '#00d97e', '#4d9fff', '#ff3b5c', '#9b59ff', '#ffffff'];
    const parts = Array.from({ length: count }).map(() => ({
      x: W / 2 + (Math.random() - 0.5) * 60,
      y: H / 2 - 20,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 12 - 4,
      g: 0.35 + Math.random() * 0.2,
      s: 3 + Math.random() * 5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      c: colors[Math.floor(Math.random() * colors.length)]!,
    }));
    let raf = 0;
    const step = () => {
      ctx.clearRect(0, 0, W, H);
      let alive = false;
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.g;
        p.rot += p.vr;
        if (p.y < H + 20) alive = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.globalAlpha = Math.max(0, 1 - p.y / H);
        ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      }
      if (alive) raf = requestAnimationFrame(step);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [count]);
  return <canvas ref={ref} className="absolute inset-0 w-full h-full" />;
}

// ── COUNT-UP number ───────────────────────────────────────────────────────
export function CountUp({
  value,
  decimals = 2,
  className = '',
  duration = 900,
  from: fromProp,
}: {
  value: number;
  decimals?: number;
  className?: string;
  duration?: number;
  from?: number;
}) {
  // Start AT the first value rather than sweeping up from 0.
  //
  // Session games open at exactly 1.00x, but the old version animated 0 -> 1.00
  // on mount, so the player briefly saw 0.95x / 0.97x / 0.99x and it looked like
  // they had already lost money before touching anything. `from` lets a caller
  // pin the resting value (session games pass 1).
  const initial = fromProp ?? value;
  const [display, setDisplay] = useState(initial);
  const prev = useRef(initial);
  const mounted = useRef(false);
  useEffect(() => {
    // no animation on first paint — just show the real number
    if (!mounted.current) {
      mounted.current = true;
      prev.current = value;
      setDisplay(value);
      return;
    }
    const from = prev.current;
    const to = value;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * eased);
      if (p < 1) requestAnimationFrame(step);
      else prev.current = to;
    };
    requestAnimationFrame(step);
  }, [value, duration]);
  return <span className={className}>{display.toFixed(decimals)}</span>;
}

// ── GLASS PANEL ───────────────────────────────────────────────────────────
export function Glass({
  children,
  className = '',
  glow,
}: {
  children: React.ReactNode;
  className?: string;
  glow?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-md shadow-[0_8px_32px_rgba(0,0,0,0.35)] ${className}`}
      style={
        glow
          ? { boxShadow: `0 0 24px ${glow}33, inset 0 1px 0 rgba(255,255,255,0.06)` }
          : {
              boxShadow:
                '0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)',
            }
      }
    >
      {children}
    </div>
  );
}

// ── MULTIPLIER PILL ───────────────────────────────────────────────────────
export function MultiplierPill({
  value,
  color = GOLD,
  label,
}: {
  value: string | number;
  color?: string;
  label?: string;
}) {
  return (
    <div
      className="inline-flex flex-col items-center px-5 py-2 rounded-2xl border"
      style={{
        borderColor: `${color}44`,
        background: `${color}12`,
        boxShadow: `0 0 18px ${color}22`,
      }}
    >
      {label && (
        <span
          className="t-label-sm uppercase tracking-widest"
          style={{ color: `${color}bb` }}
        >
          {label}
        </span>
      )}
      <span className="t-headline tabular-nums" style={{ color }}>
        {value}×
      </span>
    </div>
  );
}

// ── BIG ACTION TILE — for pick-based games (mines, tower, stairs…) ────────
export function ActionTile({
  children,
  onClick,
  state,
  disabled,
  className = '',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  state?: 'idle' | 'safe' | 'mine' | 'active' | 'faded';
  disabled?: boolean;
  className?: string;
}) {
  const styles: Record<string, { cls: string; style: React.CSSProperties }> = {
    idle: {
      cls: 'bg-gradient-to-b from-[#262640] to-[#15152a] border-white/15 hover:border-gold/50 hover:shadow-[0_0_18px_rgba(245,200,66,0.25)]',
      style: {},
    },
    active: {
      cls: 'bg-gradient-to-b from-[#2b2333] to-[#1a1422] border-gold/60',
      style: {
        boxShadow:
          '0 0 22px rgba(245,200,66,0.35), inset 0 0 18px rgba(245,200,66,0.10)',
      },
    },
    safe: {
      cls: 'bg-gradient-to-b from-[#0e3d2a] to-[#0a2a1c] border-green/50',
      style: { boxShadow: '0 0 16px rgba(0,217,126,0.3)' },
    },
    mine: {
      cls: 'bg-gradient-to-b from-[#4a1420] to-[#2a0a12] border-red/60',
      style: { boxShadow: '0 0 22px rgba(255,59,92,0.4)' },
    },
    faded: { cls: 'bg-white/[0.03] border-white/5 opacity-40', style: {} },
  };
  const s = styles[state ?? 'idle']!;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`relative rounded-xl border transition-all duration-200 active:scale-90 disabled:opacity-60 ${s.cls} ${className}`}
      style={s.style}
    >
      {children}
    </button>
  );
}

// ── WIN ZONE / INFO STRIP ─────────────────────────────────────────────────
export function InfoStrip({
  items,
}: {
  items: Array<{ label: string; value: React.ReactNode; color?: string }>;
}) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {items.map((it, i) => (
        <div
          key={i}
          className="px-4 py-2 rounded-xl bg-white/[0.04] border border-white/8 min-w-[84px] text-center"
        >
          <p className="t-label-sm text-muted uppercase tracking-wide text-[10px]">
            {it.label}
          </p>
          <p className="t-num-md mt-0.5" style={{ color: it.color ?? '#fff' }}>
            {it.value}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── SPINNING DECORATIVE RING ──────────────────────────────────────────────
export function GlowRing({
  size = 160,
  color = GOLD,
  children,
  spinning = false,
}: {
  size?: number;
  color?: string;
  children?: React.ReactNode;
  spinning?: boolean;
}) {
  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <div
        className="absolute inset-0 rounded-full animate-float-slow"
        style={{
          background: `radial-gradient(circle, ${color}26 0%, transparent 70%)`,
          filter: 'blur(6px)',
        }}
      />
      <div
        className="absolute inset-[7%] rounded-full border-2 border-dashed animate-spin-slow"
        style={{
          borderColor: `${color}55`,
          animationDuration: spinning ? '2.2s' : '40s',
        }}
      />
      <div
        className="absolute inset-[14%] rounded-full"
        style={{ border: `1px solid ${color}33` }}
      />
      <div className="relative">{children}</div>
      <style>{`@keyframes spinSlow { to { transform: rotate(360deg) } } .animate-spin-slow { animation: spinSlow 40s linear infinite }`}</style>
    </div>
  );
}

// ── PULSE DOT ─────────────────────────────────────────────────────────────
export function PulseDot({
  color = GREEN,
  size = 8,
}: {
  color?: string;
  size?: number;
}) {
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      <span
        className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
        style={{ background: color }}
      />
      <span
        className="relative inline-flex rounded-full"
        style={{ width: size, height: size, background: color }}
      />
    </span>
  );
}
