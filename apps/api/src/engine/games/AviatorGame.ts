// apps/api/src/engine/games/AviatorGame.ts — shared-round crash game (v3 GAME 1 + v8 GUI)
// Crash point: HMAC(serverSeed, roundId) → first 8 chars; h % 10000 < gate → 1.00 takeoff
// bust; else max(1.00, (100/(1-h/2^32)) * (1-houseEdge) / 100), remapped through
// admin crash_distribution. The gate is the operator difficulty knob (see difficulty.ts).
import crypto from 'crypto';
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import {
  DifficultyLevel,
  crashGateForLevel,
  crashInstantGateProb,
} from '../difficulty';

export interface CrashDistribution {
  [range: string]: number;
}

/**
 * Instant-bust gate (PRODUCT DECISION 2026-08-21, operator-directed): every
 * round one independent hash draw decides "explode at takeoff". At NORMAL the
 * gate is ~63.54% of hash space; adding the ~4% of surviving draws the
 * geometric formula naturally clamps to 1.00 puts overall P(crash = exactly
 * 1.00x) at 65% — i.e. roughly 2 of every 3 rounds never leave the runway.
 *
 * Consequence the operator accepted in writing: P(crash≥T) = 0.35·0.96/T at
 * NORMAL, so overall RTP ≈ 33.6% (house edge ≈ 66%). Survivor rounds keep the
 * exact calibrated shape (P(crash≥T | survived) = 0.96/T) because the gate
 * (h mod 10000) and the curve draw (h / 2^32) are near-independent bits of the
 * same uniform h. Provably-fair integrity is unaffected: roundId is hashed
 * BEFORE bets close, the level lives in the round's config snapshot, and the
 * verifier replays this exact function with the same gate.
 */
export const CRASH_INSTANT_GATE = crashGateForLevel('normal'); // 6354
export const CRASH_INSTANT_GATE_PROB = crashInstantGateProb('normal'); // 0.6354…

/**
 * Crash math v2 (OPERATOR DECISIONS 2026-08-23):
 *  - every round STARTS at 0.10x and climbs — the multiplier never originates
 *    at 1.00x;
 *  - a gated round now crashes BELOW 1x (0.10–0.99), not exactly at 1.00x —
 *    "it should not often even reach 1x". At NORMAL the gate share stays
 *    ~63.5% of all rounds (the accepted knob, re-purposed);
 *  - the crash point may NEVER exceed 12.00x ("never above 12x");
 *  - a bet without a cashout loses in full; a cashout BELOW 1x pays its
 *    fraction (partial stake-back — retention-friendly sting).
 * `crash-hmac-v1` rounds replay through the LEGACY functions below (gate =
 * exactly 1.00x); v2 rounds are stamped `crash-hmac-v2` and replay through
 * generateCrashPoint() + the clamped final map. Same hash, different
 * interpretation of the second 32-bit word — no round ever crosses lanes.
 */
export const CRASH_CAP = 12;
export const CRASH_MIN_START = 0.1;
/** milliseconds to taxi 0.10 → 1.00 before the classic e^(g·t) climb */
export const CRASH_TAXI_MS = 2500;

/**
 * v2 crash point generator. Gate hit → sub-1 bust point from hash bits 8..15
 * (uniform over [0.10, 0.99], 2dp). Gate pass → legacy geometric raw
 * (uncapped here: the ≤CRASH_CAP clamp lands after the distribution remap,
 * exactly like the manager computes it).
 */
export function generateCrashPoint(
  serverSeed: string,
  roundId: string,
  houseEdge = 0.04,
  gate: number = CRASH_INSTANT_GATE
): number {
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(roundId);
  const hash = hmac.digest('hex');
  const h = parseInt(hash.substring(0, 8), 16);
  const e = Math.pow(2, 32);
  if (h % 10000 < gate) {
    const u2 = parseInt(hash.substring(8, 16), 16) / e;
    return Math.floor((CRASH_MIN_START + u2 * 0.89) * 100) / 100; // [0.10, 0.99]
  }
  return Math.max(1.0, ((100 / (1 - h / e)) * (1 - houseEdge)) / 100);
}

/**
 * The final crash point a v2 round displays/pays: distribution-remapped, then
 * hard-capped. Buckets/ranges above the cap roll into exactly CRASH_CAP.
 */
export function crashPointV2(raw: number, distribution: CrashDistribution): number {
  const remapped = remapCrashPoint(raw, distribution);
  return Math.min(CRASH_CAP, Math.max(CRASH_MIN_START, remapped));
}

/** Live display multiplier at `elapsedMs` — every consumer (tick broadcast,
 *  join price, cashout claim, client mirror) must use THIS curve: 0.10 →
 *  1.00 across the taxi phase, then the classic exponential from 1.00. */
export function crashMultiplierAt(growth: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return CRASH_MIN_START;
  if (elapsedMs < CRASH_TAXI_MS)
    return CRASH_MIN_START * Math.exp((Math.log(10) / CRASH_TAXI_MS) * elapsedMs);
  return Math.exp(growth * (elapsedMs - CRASH_TAXI_MS));
}

export function generateCrashPointRaw(
  serverSeed: string,
  roundId: string,
  houseEdge = 0.04,
  gate: number = CRASH_INSTANT_GATE
): number {
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(roundId);
  const hash = hmac.digest('hex');
  const h = parseInt(hash.substring(0, 8), 16);
  const e = Math.pow(2, 32);
  if (h % 10000 < gate) return 1.0; // instant takeoff bust (level-scaled gate)
  return Math.max(1.0, ((100 / (1 - h / e)) * (1 - houseEdge)) / 100);
}

/**
 * Map a raw crash point through the admin weight buckets (docs/13 AVIATOR).
 * DETERMINISTIC: the within-bucket position derives from the raw value itself
 * (was Math.random() — that made crash rounds unverifiable; docs/14 PF rule).
 *
 * INPUT DOMAIN: the crash-formula raw from generateCrashPointRaw() ∈ [0.96, 96)
 * (raw = 0.96/(1−x), x uniform). Its true CDF is P(raw < r) = 1 − 0.96/r, so we
 * map back to the uniform x before bucket selection — a raw of ~1.92 (median)
 * must NOT collapse into the first bucket.
 */
export function remapCrashPoint(raw: number, distribution: CrashDistribution): number {
  // Instant takeoff bust: a raw ≤ 1.00 is a runway explosion and MUST display
  // as exactly 1.00x ("Flew Away @ 1.00x"). The old code pushed that raw into
  // the lowest weight bucket ("1.00-1.10") where sin() picked a mid-bucket
  // spot, so instant-crash rounds always showed ~1.02-1.10x and the game
  // never visibly blasted at takeoff.
  // ≤1 never enters the bucket table: legacy gate rounds carry exactly 1.00
  // unchanged, v2 gate rounds carry their sub-1 bust value unchanged.
  if (raw <= 1.0) return raw;
  const entries = Object.entries(distribution).sort(
    (a, b) => rangeLower(a[0]!) - rangeLower(b[0]!)
  );
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const scaled = Math.min(0.999999, Math.max(0, 1 - 0.96 / Math.max(raw, 0.9601))); // uniform x
  if (entries.length === 0 || total <= 0) return Math.max(1, raw); // no remap table: keep the raw point
  let cumulative = 0;
  let chosen = entries[entries.length - 1]![0];
  for (const [range, weight] of entries) {
    cumulative += weight / total;
    if (scaled <= cumulative) {
      chosen = range;
      break;
    }
  }
  const [lo, hi] = rangeBounds(chosen);
  // deterministic pseudo-position inside the bucket (stable for a given raw)
  const t = Math.abs(Math.sin(raw * 1000003)) % 1;
  // C-04: a '+' tail bucket has hi = Infinity, and `lo + t*(Infinity − lo)`
  // literally computed the float +Infinity as a ROUND RESULT — an Infinite crash
  // point is a plane that never falls, an unpayable stored multiplier and a
  // poisoned pricing curve. The tail is not unlimited: bound it to a financed
  // ceiling scaled to the bucket (e.g. "10+" → 10x–110x), duty-cycled by its
  // configured weight like every other bucket.
  const loSafe = Number.isFinite(lo) ? lo : 1; // degenerate "bare +" bucket
  return loSafe + t * Math.max(0, crashTailUpper(loSafe, hi) - loSafe);
}

/**
 * C-04: the effective upper bound of a distribution bucket. Open-ended "+"
 * ranges are capped so a crash point is ALWAYS finite and always payable at
 * the platform's liability ceiling.
 */
export function crashTailUpper(lo: number, hi: number): number {
  if (Number.isFinite(hi)) return hi;
  if (!Number.isFinite(lo)) return 101; // degenerate "bare +" bucket
  return Math.max(lo + 100, lo * 3);
}
function rangeLower(r: string): number {
  return parseFloat(r.split('-')[0] || r.replace('+', '')) || 0;
}
function rangeBounds(r: string): [number, number] {
  const [a, b] = r.split('-');
  const lo = parseFloat(a ?? '0');
  if (r.endsWith('+') || !b) return [lo, Infinity];
  return [lo, parseFloat(b ?? '0')];
}

export class AviatorGame extends BaseGame {
  readonly slug: string = 'aviator';

  /** Per-bet resolve: solo/deterministic fallback (real rounds go through CrashRoundManager). */
  resolve({
    rawOutcome,
    config,
    choices,
    forceMode,
    difficulty,
  }: ResolveParams): GameHandlerResult {
    const distribution =
      (config.configJson as { crash_distribution?: CrashDistribution })
        ?.crash_distribution ?? {};
    // Same instant-bust gate as the shared CrashRoundManager rounds, scaled by
    // the operator difficulty exactly as the shared rounds scale it: below the
    // gate the plane explodes at takeoff (exactly 1.00x). Survivor rawOutcome
    // is rescaled back to uniform [0,1) so the crash curve keeps its exact
    // calibrated shape (P(crash≥T | survived) = 0.96/T) — the gate must NOT
    // leak into the survivors' curve or low multipliers silently vanish.
    const level: DifficultyLevel = difficulty ?? 'normal';
    const gateProb = crashInstantGateProb(level);
    const crashPoint =
      rawOutcome < gateProb
        ? // v2: the gate crashes the plane BELOW 1x, deterministically
          // positioned from the gate-slice fraction itself (~65% sub-1 busts).
          Math.floor(((rawOutcome / gateProb) * 0.89 + CRASH_MIN_START) * 100) / 100
        : crashPointV2(
            0.96 / Math.max(1e-6, 1 - (rawOutcome - gateProb) / (1 - gateProb)),
            distribution
          );
    // Solo/deterministic fallback only: a target multiplier for the simulated
    // round. (Auto-cashout was removed — live rounds settle on manual cashout.)
    const rawTarget = (choices as { target?: number }).target ?? 2;
    const target = Math.max(1.01, Number(rawTarget) || 2);
    // Crash games are distribution-driven: the crash point decides the outcome
    // (same semantics as CrashRoundManager shared rounds). The engine's isWin
    // only applies to FORCE_* overrides — the calibrated crash_distribution
    // enforces the house edge (P(crash>=T) = 0.96/T).
    const won =
      forceMode === 'FORCE_WIN'
        ? true
        : forceMode === 'FORCE_LOSE'
          ? false
          : crashPoint >= target;
    return {
      result: won ? 'CASHOUT' : 'BUST',
      payoutMultiplier: won ? Math.min(target, Number(config.maxWinMultiplier)) : 0,
      mappedOutcome: {
        crashPoint,
        target,
        cashedOut: won,
        multiplier: won ? target : 0,
      },
    };
  }
}

/** CrashX — same engine family, different skin/config (v3 GAME 17). */
export class CrashXGame extends AviatorGame {
  override readonly slug = 'crash-x';
}

// export for registry in BaseGame
export { remapCrashPoint as remapCrash };
