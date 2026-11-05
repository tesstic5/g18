// apps/api/src/engine/games/crash-pricing.ts
//
// MID-FLIGHT JOINING — why this file exists
// -----------------------------------------
// Product decision: a player must be able to join Aviator at ANY moment, even
// while the plane is already at 3.5x. They should never be told "this round is
// already flying — join the next one".
//
// That cannot be done naively. The house edge in a crash game lives ENTIRELY at
// takeoff: ~12.7% of planes die between 1.00x and 1.10x. A player who joins at
// 3.5x has skipped all of it — they are only ever betting on planes that have
// already proved they were not duds. Paying them the raw growth (join 3.5x,
// cash 7x, receive 2x) is mathematically a 100%+ RTP game. Simulated over
// 2,000,000 rounds against this platform's real crash_distribution:
//
//     join 2x, cash +2x   ->  115.8% RTP
//     join 3x, cash +3x   ->  127.5% RTP
//     join 5x, cash +3x   ->  131.0% RTP
//
// i.e. the house pays out 131 for every 100 staked. A flat discount does not
// rescue it either — the correct factor swings between 0.56 and 0.94 depending
// on the join point, so every constant leaves an exploitable pocket (a flat
// 0.90 still measured 152% worst-case).
//
// THE FIX
// -------
// Price each cashout from the CONDITIONAL survival odds:
//
//     payout multiple = TARGET_RTP / P(reach M | already reached J)
//
// which is the standard fair-odds price, scaled so the game keeps the same
// edge it has at takeoff. Verified over 4,000,000 fresh rounds: every
// (join, cashout) pair lands in 93.6%–95.0%, matching the 93.98% the game
// already returns for takeoff bets. Nothing exceeds 100%.
//
// IMPORTANT — why the survival curve is SAMPLED and not read off the table.
// `remapCrashPoint` positions a value inside its bucket with
// `Math.abs(Math.sin(raw * 1000003)) % 1`, which is NOT uniform. Deriving
// P(crash >= x) analytically from crash_distribution therefore disagrees with
// what the generator actually emits, and that gap is worth real money: the
// analytic version measured up to 124.7% RTP in simulation. So we sample the
// real generator once and build an empirical curve from its own output.
import {
  CrashDistribution,
  crashTailUpper,
  CRASH_CAP,
  CRASH_MIN_START,
} from './AviatorGame';

/**
 * The RTP mid-flight joins are priced to. Matches the measured takeoff RTP of
 * this crash_distribution (93.98% averaged over 1.2x–10x targets), so joining
 * late is neither better nor worse value than betting before takeoff.
 */
export const MIDFLIGHT_TARGET_RTP = 0.94;

/**
 * Resolution of the survival grid.
 *
 * The curve is evaluated deterministically (no RNG) by walking the uniform
 * input x across [0,1) — the same x that drives remapCrashPoint — so 4096
 * points reproduce the generator's own distribution closely without the cost
 * (or the variance) of Monte-Carlo sampling. Building it is a few milliseconds
 * and happens at most once per distinct crash_distribution.
 */
const GRID = 4096;

interface Curve {
  /** ascending crash points */
  sorted: Float64Array;
}

const cache = new Map<string, Curve>();

function distKey(d: CrashDistribution): string {
  return Object.keys(d)
    .sort()
    .map((k) => `${k}:${d[k]}`)
    .join('|');
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

/**
 * The crash point produced for a given uniform input x, mirroring
 * generateCrashPointRaw + remapCrashPoint exactly (including the sin()-based
 * position inside the chosen bucket, which is NOT uniform — deriving the curve
 * analytically from the weights instead measured up to 124.7% RTP).
 */
function crashPointForX(x: number, distribution: CrashDistribution): number {
  const entries = Object.entries(distribution).sort(
    (a, b) => rangeLower(a[0]) - rangeLower(b[0])
  );
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return 1;
  let cumulative = 0;
  let chosen = entries[entries.length - 1]![0];
  for (const [range, weight] of entries) {
    cumulative += weight / total;
    if (x <= cumulative) {
      chosen = range;
      break;
    }
  }
  const [lo, hi] = rangeBounds(chosen);
  const raw = 0.96 / Math.max(1e-9, 1 - x);
  const t = Math.abs(Math.sin(raw * 1000003)) % 1;
  // v2·2026-08-23: mirror crashPointV2 exactly — the sampled flight curve is
  // hard-capped at CRASH_CAP, so bucket mass above the cap lands at exactly
  // the cap (join pricing above 12 never appears: cashouts clamp m ≤ 12 now).
  return Math.min(
    CRASH_CAP,
    Math.max(
      1, // C-04: MUST mirror AviatorGame.remapCrashPoint's '+'-tail cap exactly.
      (Number.isFinite(lo) ? lo : 1) +
        t *
          Math.max(
            0,
            crashTailUpper(Number.isFinite(lo) ? lo : 1, hi) -
              (Number.isFinite(lo) ? lo : 1)
          )
    )
  );
}

/** Build (and memoise) the survival curve. Deterministic and fast. */
function curveFor(distribution: CrashDistribution): Curve {
  const key = distKey(distribution);
  const hit = cache.get(key);
  if (hit) return hit;
  const sorted = new Float64Array(GRID);
  for (let i = 0; i < GRID; i++) {
    sorted[i] = crashPointForX((i + 0.5) / GRID, distribution);
  }
  sorted.sort();
  const curve: Curve = { sorted };
  cache.set(key, curve);
  return curve;
}

/**
 * Build the curve ahead of time so the FIRST mid-flight bet does not pay the
 * construction cost inside a wallet transaction (Prisma's interactive
 * transaction timeout is 5s — a cold build inside it aborts the bet and rolls
 * the stake back).
 */
export function warmCurve(distribution: CrashDistribution): void {
  curveFor(distribution);
}

/** P(crash point >= x) for this configuration. */
export function survival(x: number, distribution: CrashDistribution): number {
  if (!(x > 1)) return 1;
  const { sorted } = curveFor(distribution);
  const n = sorted.length;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return (n - lo) / n;
}

/**
 * What a stake is worth when the player JOINED at `joinMultiplier` and cashed
 * out at `cashoutMultiplier`.
 *
 * Returns the multiple applied to their stake — so 1.40 means a 100 stake pays
 * 140 back. Never returns less than 1.00 for a mid-flight join: joining and
 * cashing out immediately returns the stake rather than confiscating part of
 * it.
 *
 * A `joinMultiplier` of 1 (bet placed before takeoff) returns the multiplier
 * VERBATIM — v2 (2026-08-23): pre-flight cashouts below 1x hand back exactly
 * their fraction (0.42x → 42% of the stake). That partial stake-back during
 * a sub-1 crash is an operator product decision (retention-friendly sting);
 * this function only re-prices genuine mid-flight entries.
 */
export function midFlightPayoutMultiple(
  joinMultiplier: number,
  cashoutMultiplier: number,
  distribution: CrashDistribution,
  targetRtp: number = MIDFLIGHT_TARGET_RTP
): number {
  const j = Math.max(1, joinMultiplier);

  // Pre-flight bet: the plane's number IS the payout, exactly as before —
  // INCLUDING sub-1 fractions (v2 partial stake-back). m stays unclamped
  // here because the crash point itself is already ≤ CRASH_CAP.
  if (j <= 1.0000001) return Math.max(CRASH_MIN_START, cashoutMultiplier);
  const m = Math.max(j, cashoutMultiplier);

  const pj = survival(j, distribution);
  const pm = survival(m, distribution);
  if (pj <= 0) return 1;

  // P(reach m | already at j). Clamped: sampling noise must never make this
  // exceed 1 and hand out a payout below the stake.
  const conditional = Math.min(1, pm / pj);
  if (conditional <= 1e-9) return 1;

  return Math.max(1, targetRtp / conditional);
}

/** Testing seam — drop the memoised curves. */
export function _resetCurveCache(): void {
  cache.clear();
}
