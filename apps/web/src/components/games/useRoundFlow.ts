// apps/web/src/components/games/useRoundFlow.ts
//
// THE PROBLEM THIS SOLVES
// -----------------------
// Every game passed the server's `result` straight to <ResultBanner>. The banner
// therefore appeared the moment the HTTP response landed (~1.5s after the tap),
// while the board was still mid-animation:
//
//     wheel stops spinning at   3100ms
//     banner announced the win  ~1500ms     <-- 1.6 SECONDS EARLY
//     keno finishes its draw    3800ms
//     banner announced the win  ~1500ms     <-- 2.3 SECONDS EARLY
//
// So the game told you the answer before it had finished playing. That is the
// "sometimes it shows the results without even playing the game" report.
//
// THE FIX — EXPLICIT COMPLETION, NOT A GUESS TIMER
// ------------------------------------------------
// The first version of this hook held the outcome back for a FIXED duration
// (`animationMs`) and assumed the board's animation lasted exactly that long.
// It never did: timers drift, CSS transitions coalesce on round 2, a janky tab
// runs late — and every mismatch either spoiled the answer early or left a dead
// pause. Worst case, measured: round 1 tumbled 2.6s, round 2 showed the verdict
// at 0ms because the board's own effect never re-fired while the gate still
// opened on schedule.
//
// Now the BOARD owns the reveal. The game animates from `flow.outcome` and
// calls `flow.complete()` — or passes `onRoundComplete` to its own completion
// point (transition end, last ball landing, final scratch). `revealed` flips
// true ONLY when the board says it is done:
//
//     phase 'ready'    nothing happening, board invites a choice
//     phase 'playing'  the event is running; the answer is KNOWN but HIDDEN
//     phase 'revealed' the board reported completion; now show the outcome
//
// `fallbackMs` is a dead-man's switch ONLY: if the board never reports (a
// future game forgets the call, an exception kills its timers), the gate opens
// anyway so the UI can never wedge on a settled bet. It is deliberately much
// longer than any real animation.
'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type RoundPhase = 'ready' | 'playing' | 'revealed';

export interface RoundFlow<T> {
  /** where the round is right now */
  phase: RoundPhase;
  /** true while the event is animating (answer known internally, hidden on screen) */
  playing: boolean;
  /** true once the BOARD has reported completion and the outcome may be shown */
  revealed: boolean;
  /**
   * The outcome, but ONLY after the board completed. While the animation is
   * running this is null, so a component literally cannot render the answer
   * early even by accident.
   */
  shown: T | null;
  /**
   * The outcome of the round being animated — stable across the page's
   * null-then-set handoff between rounds. Boards must animate from THIS, never
   * from the raw `outcome` prop (which the page parks at null while the next
   * bet is in flight).
   */
  outcome: T | null;
  /** 0 -> 1 suggested animation progress (drives shared sub-step timing) */
  progress: number;
  /**
   * A number that increases by one for every NEW round.
   *
   * Games key their animation effect on this. It is STATE, not a ref, and it is
   * bumped in a layout effect, so the board's first painted frame of round N+1
   * already carries the new key — round 2 can never inherit round 1's end pose
   * or skipped effect.
   */
  roundKey: number;
  /**
   * THE board completion callback. Call it when the animation the player was
   * watching has genuinely finished (transition end, last step timer, final
   * scratch). Idempotent per round. Falls back to `onReveal` so existing
   * callers that passed their completion handler as the 3rd argument keep
   * working.
   */
  complete: () => void;
}

/**
 * Hold a round's outcome back until the board reports its animation complete.
 *
 * @param outcome    the server result (null between rounds)
 * @param fallbackMs dead-man's switch: reveal anyway after this long. Pass
 *                   `animMs(slug) * 1.5` style values — long enough that a
 *                   healthy board ALWAYS beats it.
 * @param onReveal   legacy completion handler (3rd positional arg). Boards may
 *                   call `flow.complete()` at their true completion point
 *                   instead — both end the round exactly once.
 */
export function useRoundFlow<T>(
  outcome: T | null,
  fallbackMs: number,
  onReveal?: () => void
): RoundFlow<T> {
  const [phase, setPhase] = useState<RoundPhase>('ready');
  const onRevealRef = useRef(onReveal);
  useEffect(() => {
    onRevealRef.current = onReveal;
  }, [onReveal]);
  const [progress, setProgress] = useState(0);
  // Prevents the fallback timer from firing after an explicit complete().
  const doneToken = useRef(0);

  const [roundId, setRoundId] = useState(0);
  const prevOutcome = useRef<T | null>(null);
  // `live` is the outcome of the round currently being animated. It is set when
  // a round starts and is NOT cleared when the page briefly nulls `outcome`
  // between rounds — a board keyed on roundKey would otherwise re-run its
  // animation effect at the exact moment outcome was null, hit its own
  // `if (!outcome) return` guard, and never animate again.
  const [live, setLive] = useState<T | null>(null);
  // Round N's completion must never leak into round N+1, so remember which
  // round `complete()` was armed for and ignore stale/duplicate calls.
  const armedRound = useRef(0);

  // Reset a new round in a layout effect so React commits `playing` before the
  // browser can paint the previous round's revealed phase.
  useLayoutEffect(() => {
    if (outcome === prevOutcome.current) return;
    prevOutcome.current = outcome;
    if (outcome != null) {
      setLive(outcome);
      setPhase('playing');
      setProgress(0);
      setRoundId((n) => n + 1);
    }
  }, [outcome]);

  useEffect(() => {
    if (live == null || roundId === 0) {
      setPhase('ready');
      setProgress(0);
      return;
    }

    const mine = ++doneToken.current;
    armedRound.current = roundId;
    setPhase('playing');
    setProgress(0);

    const start = performance.now();
    let raf = 0;
    // Suggested pacing only — revealed NEVER comes from this clock.
    const guide = Math.max(1, fallbackMs * 0.66);
    const tick = () => {
      if (doneToken.current !== mine) return;
      const p = Math.min(1, (performance.now() - start) / guide);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // Dead-man's switch: if the board never reports, open the gate late rather
    // than wedge the UI on a settled bet. Longer than every real animation.
    const fallback = setTimeout(
      () => {
        if (doneToken.current !== mine) return;
        setPhase('revealed');
        onRevealRef.current?.();
      },
      Math.max(600, fallbackMs)
    );

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fallback);
    };
  }, [roundId, fallbackMs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Explicit board completion — the ONLY intended path to `revealed`.
  const complete = useCallback(() => {
    if (armedRound.current === 0) return; // no round in flight
    // Arm exactly once per round: ignore late second calls from the same
    // round's teardown chains.
    armedRound.current = 0;
    doneToken.current += 1; // cancel the fallback
    // IMPORTANT: state updates first, the pointer-form effect callback AFTER.
    // onReveal used to run INSIDE the setPhase updater; when the reveal
    // handler itself setState in the parent (round-complete bookkeeping), React
    // threw "Cannot update <GamePage> while rendering <*Visual>".
    setPhase('revealed');
    setProgress(1);
    onRevealRef.current?.();
  }, []);

  const revealed = phase === 'revealed';
  return {
    phase,
    playing: phase === 'playing',
    revealed,
    shown: revealed ? live : null,
    /** the round being animated — stable across the page's null-then-set */
    outcome: live,
    progress,
    roundKey: roundId,
    complete,
  };
}

/**
 * How long each game's event should take, in ms.
 *
 * These are now REFERENCE durations: boards use them to pace their own
 * animation, and `useRoundFlow` uses them (×1.5 at call sites) purely as the
 * fallback. The reveal itself is always the board's explicit `complete()`.
 *
 * These are deliberately LONG. The originals were 250-700ms, which felt like a
 * spreadsheet updating rather than a game being played:
 *   dice 650ms, lucky-number 250ms, dragon-tiger 700ms, thimbles 320ms,
 *   and baccarat / roulette / plinko / limbo had no scripted timing at all.
 */
export const ANIM_MS: Record<string, number> = {
  dice: 2600,
  'coin-flip': 2000,
  wheel: 4200,
  'ring-of-fortune': 4200,
  limbo: 3000,
  keno: 4400, // 20 balls drawn one at a time
  'lucky-number': 3200, // three reels stopping in sequence
  'scratch-card': 1200, // the player does the scratching themselves
  thimbles: 3200, // proper shuffle
  plinko: 3000, // ball physics down to the slots
  roulette: 4200,
  baccarat: 3000, // card by card, with the third-card draw
  'dragon-tiger': 2000,
  wingo: 2000,
  mines: 700, // per-tile dig, must stay snappy
  tower: 900,
  stairs: 900,
  'hi-lo': 1200,
};

export const animMs = (slug: string) => ANIM_MS[slug] ?? 2500;

/** Fallback budget for `useRoundFlow`: real animation × 1.5 (min 900ms). */
export const flowFallbackMs = (slug: string) => Math.max(900, animMs(slug) * 1.5);
