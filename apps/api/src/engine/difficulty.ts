// apps/api/src/engine/difficulty.ts — operator win-frequency control.
//
// WHY THIS EXISTS
// ---------------
// Every one-shot game derives its win from the SAME committed HMAC draw
// (provably fair). A naive "house knob" that re-rolls losing rounds breaks
// that commitment and can never be verified again. Instead the engine keeps
// ONE draw and decides win/lose against a probability that the operator can
// scale:
//
//     effectiveWinChance = fairWinChance(game, choices) x difficultyFactor
//
// The committed draw `u` is compared against that chance; the game's handler
// then maps the SAME `u` onto a display-consistent win or lose outcome (a dice
// roll that actually beats the target on a win, a wheel segment that actually
// contains the winning bucket, ...). Display and ledger therefore can never
// disagree — "if they win they win, if they lose they lose".
//
// When difficulty is NORMAL the factor is 1, the chance equals the game's fair
// chance and the decision is provably fair: u < p_fair is exactly the fair
// event for every game whose win region is a threshold band of width p_fair
// (dice over/under, limbo, wheel bucket, hi-lo…). For every other game the
// deviation is fully documented by `difficulty` inside each round's stored
// config snapshot (auditable provably-fair metadata).
//
// LEVELS (operator-facing, per product spec)
//   easy      x 1.5  — casual-friendly
//   normal    x 1.0  — the game's configured odds, provably fair
//   hard      x 0.5
//   impossible x 0.1 — winning becomes a rare event (still possible)
import { getSetting } from '../services/settings';
import type { GameConfig } from '../generated/prisma/client';

export type DifficultyLevel = 'easy' | 'normal' | 'hard' | 'impossible';
export const DIFFICULTY_LEVELS: readonly DifficultyLevel[] = [
  'easy',
  'normal',
  'hard',
  'impossible',
];

/**
 * Win-frequency multiplier per level. "Gentle" profile chosen by the operator:
 * hard halves the win frequency, impossible cuts it to 10%, easy raises it by
 * half. Factor NEVER touches the payout table — a win always pays the game's
 * price, only its odds of occurring shift.
 */
export const DIFFICULTY_FACTORS: Record<DifficultyLevel, number> = {
  easy: 1.5,
  normal: 1.0,
  hard: 0.5,
  impossible: 0.1,
};

/** Chance clamps: never a guaranteed win, never a mathematically dead bet. */
export const MIN_EFFECTIVE_CHANCE = 0.001; // 0.1%
export const MAX_EFFECTIVE_CHANCE = 0.98; // 98%

/** One-shot games that difficulty + force overrides apply to. Session games
 *  (mines/tower/stairs/hi-lo — the player owns each move; steering the round
 *  mid-game is impossible to render honestly) and shared rounds (aviator,
 *  crashx, wingo — one outcome for thousands of players) are excluded BY
 *  DESIGN; the admin panel greys their controls out. */
export const DIFFICULTY_AWARE_SLUGS: readonly string[] = [
  'dice',
  'limbo',
  'coin-flip',
  'thimbles',
  'wheel',
  'ring-of-fortune',
  'roulette',
  'keno',
  'plinko',
  'lucky-number',
  'dragon-tiger',
  'baccarat',
  'scratch-card',
];
/** Session games stay exempt: the player owns each move mid-session, so a
 *  win-frequency knob can't be rendered honestly there (design note kept
 *  intentionally — operator re-confirmed 2026-08-26). WinGo is not listed
 *  here because it uses lock-time book-fade (wingo-book.ts), not this factor. */
export const DIFFICULTY_EXEMPT_SLUGS: readonly string[] = [
  'mines',
  'tower',
  'stairs',
  'hi-lo',
];

/** Crash (shared-round) games whose takeoff-blast share is the level knob. */
export const CRASH_LEVEL_SLUGS: readonly string[] = ['aviator', 'crash-x'];

/**
 * WinGo — difficulty via lock-time book fade (not this factor, not a payout
 * morph). One ball for the room; winners always get 1.96×. Easy/Normal HMAC
 * uniform 0–9. Hard 80% cheapest winning-stake digit / 20% HMAC. Impossible
 * always cheapest. See `engine/games/wingo-book.ts`.
 */

/**
 * Every slug whose difficulty control is live in the panel. Crash games are
 * difficulty-capable but force-override EXEMPT (a forced verdict cannot be
 * rendered round-wide for thousands of simultaneous shared-round bettors).
 */
export const DIFFICULTY_CAPABLE_SLUGS: readonly string[] = [
  ...DIFFICULTY_AWARE_SLUGS,
  ...CRASH_LEVEL_SLUGS,
  'wingo',
];

/**
 * Takeoff survival at NORMAL: 35% of rounds leave the runway, 65% explode at
 * exactly 1.00x (PRODUCT DECISION 2026-08-21: "the plane explodes right away
 * 65% of the time"). The level factor scales survival exactly like
 * effectiveWinChance scales a one-shot game's win frequency:
 *   easy      → 52.5% survive (47.5% blast)
 *   normal    → 35.0% survive (65% blast)
 *   hard      → 17.5% survive (82.5% blast)
 *   impossible→  3.5% survive (96.5% blast)
 * House edge and the survivor crash curve are untouched — only how often a
 * round is allowed to fly.
 */
export const CRASH_TAKEOFF_SURVIVAL_BASE = 0.35;

/** Shares meeting the level knob, derived the moment a level is asked for. */
export function crashTakeoffSurvival(level: DifficultyLevel): number {
  return effectiveWinChance(CRASH_TAKEOFF_SURVIVAL_BASE, level);
}

/**
 * Hash-gate probability that reproduces a takeoff survival of `s`. The raw
 * formula itself yields crash ≤ 1 for 4% of draws (P(0.96/(1-u) ≤ 1) = 0.04),
 * and those clamp to an instant 1.00x bust too — so the gate must pre-deduct
 * it: P(1.00x display) = g + (1-g)·0.04 = 1 - s  ⇒  g = 1 - s/0.96.
 * At NORMAL this is 1 - 0.35/0.96 = 0.63542 — the calibrated constant kept in
 * AviatorGame.CRASH_INSTANT_GATE (6354/10000 must equal this).
 */
export function crashInstantGateProb(level: DifficultyLevel): number {
  const s = crashTakeoffSurvival(level);
  return Math.min(1, Math.max(0, 1 - s / 0.96));
}

/** Hash-gate threshold out of 10000 for generateCrashPointRaw's `h % 10000 < gate`. */
export function crashGateForLevel(level: DifficultyLevel): number {
  return Math.round(crashInstantGateProb(level) * 10000);
}

export function isDifficultyLevel(v: unknown): v is DifficultyLevel {
  return typeof v === 'string' && (DIFFICULTY_LEVELS as readonly string[]).includes(v);
}

/**
 * Resolve the level in force for a bet: the game's own override
 * (GameConfig.configJson.difficulty) wins; otherwise the platform-wide
 * `game_difficulty` setting; otherwise 'normal'.
 */
export async function resolveDifficulty(config: GameConfig): Promise<DifficultyLevel> {
  const perGame = (config.configJson as { difficulty?: unknown })?.difficulty;
  if (isDifficultyLevel(perGame)) return perGame;
  try {
    const global = await getSetting<unknown>('game_difficulty');
    if (isDifficultyLevel(global)) return global;
  } catch {
    /* settings cache/DB down — never block a bet over cosmetics */
  }
  return 'normal';
}

/**
 * Scale a game's fair win chance into the effective one for this bet.
 * Exported (pure) so tests can assert the exact mapping.
 */
export function effectiveWinChance(fairChance: number, level: DifficultyLevel): number {
  const fair = Math.min(Math.max(fairChance, 0), 1);
  return Math.min(
    MAX_EFFECTIVE_CHANCE,
    Math.max(MIN_EFFECTIVE_CHANCE, fair * DIFFICULTY_FACTORS[level])
  );
}
