// crash v2 (crash-hmac-v2, operator decisions 2026-08-23):
//  - rounds START at 0.10x (CRASH_TAXI_MS taxi phase), never 1.00x;
//  - the difficulty gate crashes BELOW 1x ("not often even reach 1x");
//  - nothing may exceed CRASH_CAP (12x) — generator, remap, pricing curve;
//  - a cashout below 1x pays its fraction (partial stake-back).
import { describe, expect, it } from 'vitest';
import {
  CRASH_CAP,
  CRASH_MIN_START,
  CRASH_TAXI_MS,
  CRASH_INSTANT_GATE,
  crashMultiplierAt,
  crashPointV2,
  generateCrashPoint,
  generateCrashPointRaw,
} from './AviatorGame';
import { midFlightPayoutMultiple, survival, _resetCurveCache } from './crash-pricing';

const DIST = {
  '1.00-1.10': 12.7,
  '1.10-1.50': 23.3,
  '1.50-2.00': 16,
  '2.00-3.00': 16,
  '3.00-5.00': 12.8,
  '5.00-10.00': 9.6,
  '10.00-25.00': 5.8,
  '25.00-100.00': 3.9,
};

// find deterministic seeds per lane (same hmac used by the generator)
import crypto from 'crypto';
function seedFor(wantGate: boolean): { seed: string; roundId: string } {
  for (let i = 0; ; i++) {
    const seed = i.toString(16).padStart(64, 'a');
    const roundId = `probe-${i}`;
    const hash = crypto.createHmac('sha256', seed).update(roundId).digest('hex');
    const h = parseInt(hash.substring(0, 8), 16);
    if (h % 10000 < CRASH_INSTANT_GATE === wantGate) return { seed, roundId };
  }
}

describe('crash v2 generator (generateCrashPoint)', () => {
  it('gated rounds crash BELOW 1x, inside [0.10, 0.99]', () => {
    const { seed, roundId } = seedFor(true);
    const p = generateCrashPoint(seed, roundId, 0.04);
    expect(p).toBeGreaterThanOrEqual(0.1);
    expect(p).toBeLessThanOrEqual(0.99);
  });

  it('survivors follow the legacy geometric formula (curve shape unchanged)', () => {
    const { seed, roundId } = seedFor(false);
    expect(generateCrashPoint(seed, roundId, 0.04)).toBeCloseTo(
      generateCrashPointRaw(seed, roundId, 0.04),
      12
    );
  });

  it('gate share ≈ the level gate (65% stay below 1x at NORMAL)', () => {
    let sub1 = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const seed = i.toString(16).padStart(64, 'b');
      if (generateCrashPoint(seed, `r-${i}`, 0.04) < 1) sub1++;
    }
    expect(sub1 / N).toBeGreaterThan(0.6);
    expect(sub1 / N).toBeLessThan(0.68);
  });
});

describe('crashPointV2 cap', () => {
  it('NEVER exceeds 12x, whatever the distribution or raw says', () => {
    for (let i = 0; i < 4000; i++) {
      const seed = i.toString(16).padStart(64, 'c');
      const raw = generateCrashPoint(seed, `cap-${i}`, 0.04);
      const p = crashPointV2(raw, DIST);
      expect(p).toBeLessThanOrEqual(CRASH_CAP);
      expect(p).toBeGreaterThanOrEqual(CRASH_MIN_START);
    }
  });

  it('sub-1 raws pass the remap untouched (never bucketed)', () => {
    expect(crashPointV2(0.42, DIST)).toBeCloseTo(0.42, 10);
    expect(crashPointV2(0.1, DIST)).toBeCloseTo(0.1, 10);
    expect(crashPointV2(0.99, DIST)).toBeCloseTo(0.99, 10);
  });

  it('an all-tail distribution lands ON the cap, not above it', () => {
    expect(crashPointV2(77, { '12+': 100 })).toBe(CRASH_CAP);
    expect(crashPointV2(50, {})).toBe(Math.min(CRASH_CAP, 50));
  });
});

describe('taxi-phase multiplier curve (crashMultiplierAt)', () => {
  it('starts at 0.10x, hits 1.00x exactly at the taxi seam, then climbs classically', () => {
    const g = 0.00016;
    expect(crashMultiplierAt(g, 0)).toBeCloseTo(0.1, 10);
    expect(crashMultiplierAt(g, CRASH_TAXI_MS)).toBeCloseTo(1.0, 10);
    expect(crashMultiplierAt(g, CRASH_TAXI_MS + 4330)).toBeCloseTo(2.0, 2);
  });

  it('is monotonic and continuous across the taxi seam', () => {
    const g = 0.00016;
    let prev = 0;
    for (let t = 0; t <= CRASH_TAXI_MS + 5000; t += 37) {
      const m = crashMultiplierAt(g, t);
      expect(m).toBeGreaterThan(prev);
      prev = m;
    }
    // continuity at the seam: both branches agree within float noise
    const justBefore = crashMultiplierAt(g, CRASH_TAXI_MS - 0.1);
    const at = crashMultiplierAt(g, CRASH_TAXI_MS);
    expect(Math.abs(justBefore - at)).toBeLessThan(0.001);
  });
});

describe('pricing under the cap', () => {
  it('the survival curve ends at 12: P(>=13x) is zero, P(>=12x) > 0', () => {
    _resetCurveCache();
    expect(survival(CRASH_CAP + 1, DIST)).toBe(0);
    expect(survival(CRASH_CAP, DIST)).toBeGreaterThan(0);
  });

  it('above-cap joins are impossible: pricing at 13x collapses to 1x', () => {
    _resetCurveCache();
    // join at 12 (the cap), cash a 13x cashout claim → clamped safe (1x)
    expect(midFlightPayoutMultiple(12, 13, DIST)).toBe(1);
  });

  it('sub-1 cashout of a PRE-FLIGHT bet pays its exact fraction', () => {
    // joinMultiplier 1 (pre-flight) pays the displayed m verbatim — a 0.42x
    // taxi cashout hands back 42% of the stake, never 0, never 1.
    expect(midFlightPayoutMultiple(1, 0.42, DIST)).toBeCloseTo(0.42, 10);
    expect(midFlightPayoutMultiple(1, 0.1, DIST)).toBeCloseTo(0.1, 10);
  });
});
