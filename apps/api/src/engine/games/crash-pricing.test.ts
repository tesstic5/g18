// Mid-flight joining must never become free money.
//
// The house edge in a crash game lives at takeoff (NOW ~65% of rounds: the
// 2026-08-21 takeoff-blast gate — before that, ~12.7% died between 1.00x and
// 1.10x). A player joining at 3.5x skips all of it, so paying them the raw
// growth (join 3.5x, cash 7x -> 2x) is a >100% RTP game. Measured against
// this platform's real crash_distribution over 2,000,000 rounds:
//   join 2x cash +2x = 115.8%,  join 3x cash +3x = 127.5%,  join 5x +3x = 131.0%
//
// These tests pin the fix: payouts are priced from the CONDITIONAL survival
// odds, so every join point keeps the same edge pending the takeoff bet —
// while takeoff bettors face the instant-blast wall BY OPERATOR DECISION.
// The gate is orthogonal to conditional pricing for joins above 1.00x: gated
// rounds crash below every join point and factor out of the conditional odds.
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import {
  generateCrashPointRaw,
  remapCrashPoint,
  CrashDistribution,
} from './AviatorGame';
import {
  midFlightPayoutMultiple,
  survival,
  MIDFLIGHT_TARGET_RTP,
  _resetCurveCache,
} from './crash-pricing';

// the seeded production distribution (apps/api/prisma/seed.ts, aviator)
const DIST: CrashDistribution = {
  '1.00-1.10': 12.7,
  '1.10-1.50': 23.3,
  '1.50-2.00': 16.0,
  '2.00-3.00': 16.0,
  '3.00-5.00': 12.8,
  '5.00-10.00': 9.6,
  '10.00-25.00': 5.8,
  '25.00-100.00': 2.9,
  '100.00+': 1.0,
};

/** Draw crash points from the real generator. */
function sampleCrashPoints(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const seed = crypto.randomBytes(16).toString('hex');
    out.push(
      Math.max(
        1,
        remapCrashPoint(
          generateCrashPointRaw(seed, `test-${i}-${Math.random()}`, 0.04),
          DIST
        )
      )
    );
  }
  return out;
}

let rounds: number[];
beforeAll(() => {
  _resetCurveCache();
  rounds = sampleCrashPoints(120_000);
}, 120_000);

describe('mid-flight payout pricing', () => {
  it('leaves ordinary pre-takeoff bets completely untouched', () => {
    // joinMultiplier 1 => the plane's number IS the payout, exactly as before.
    for (const m of [1.2, 1.5, 2, 3, 7.5, 42]) {
      expect(midFlightPayoutMultiple(1, m, DIST)).toBeCloseTo(m, 10);
    }
  });

  it('never pays less than the stake back', () => {
    for (const j of [1.5, 2, 5, 20]) {
      // cashing out at (or below) the join point returns the stake, never less
      expect(midFlightPayoutMultiple(j, j, DIST)).toBeGreaterThanOrEqual(1);
      expect(midFlightPayoutMultiple(j, j * 0.5, DIST)).toBeGreaterThanOrEqual(1);
    }
  });

  it('pays LESS than the raw growth, which is the whole point', () => {
    // join 3x, cash 6x: raw growth is 2.00x. Paying that is the 127% RTP bug.
    const priced = midFlightPayoutMultiple(3, 6, DIST);
    expect(priced).toBeLessThan(2.0);
    expect(priced).toBeGreaterThan(1.0);
  });

  it('survival is monotonic and bounded', () => {
    let prev = survival(1, DIST);
    expect(prev).toBeCloseTo(1, 6);
    for (const x of [1.1, 1.5, 2, 3, 5, 10, 25, 100]) {
      const p = survival(x, DIST);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(prev + 1e-9); // non-increasing
      prev = p;
    }
  });

  it.each([
    [1.5, 1.5],
    [1.5, 3],
    [2, 1.5],
    [2, 2],
    [2, 3],
    [3, 1.5],
    [3, 2],
    [3, 3],
    [5, 1.5],
    [5, 2],
  ])('keeps RTP under 100%% joining at %sx and riding %sx further', (joinAt, ride) => {
    const cashAt = joinAt * ride;
    const pay = midFlightPayoutMultiple(joinAt, cashAt, DIST);

    let staked = 0;
    let returned = 0;
    for (const crash of rounds) {
      if (crash < joinAt) continue; // plane never reached the join point
      staked += 1;
      if (crash >= cashAt) returned += pay;
    }
    expect(staked).toBeGreaterThan(500); // enough samples to be meaningful

    const rtp = returned / staked;
    // The hard guarantee: the house never loses money on mid-flight joins.
    expect(rtp).toBeLessThan(1.0);
    // And it stays in the same band as a takeoff bet (~94%), so joining late is
    // neither a trap nor a bonus. Wide tolerance for Monte-Carlo noise.
    expect(rtp).toBeGreaterThan(MIDFLIGHT_TARGET_RTP - 0.1);
  });

  it('takeoff bears the ~65% blast; late joins still pay the house edge (2026-08-21 product decision)', () => {
    // OLD contract ("late joiner ≈ takeoff bettor") is intentionally retired:
    // the operator ruled that takeoff bettors eat the 65% instant-bust wall
    // (~33.6% RTP) while mid-flight joiners keep the priced ~94% game — they
    // pay the house edge, they just dodge the runway explosion by construction.
    const takeoffPay = midFlightPayoutMultiple(1, 2, DIST);
    let s1 = 0,
      r1 = 0;
    for (const c of rounds) {
      s1++;
      if (c >= 2) r1 += takeoffPay;
    }
    const takeoffRtp = r1 / s1;

    const latePay = midFlightPayoutMultiple(4, 8, DIST);
    let s2 = 0,
      r2 = 0;
    for (const c of rounds) {
      if (c < 4) continue;
      s2++;
      if (c >= 8) r2 += latePay;
    }
    const lateRtp = r2 / s2;

    // HARD FLOOR, unchanged: the house never pays >100% to mid-flight joiners —
    // the instant-bust gate did not reopen the mid-flight arbitrage.
    expect(lateRtp).toBeLessThan(1.0);
    expect(lateRtp).toBeGreaterThan(MIDFLIGHT_TARGET_RTP - 0.1);
    // NEW contract: takeoff is brutal by design (~0.35 × priced). If these
    // bounds fail, the takeoff blast is wrong, not the pricing.
    expect(takeoffRtp).toBeLessThan(0.45);
    expect(takeoffRtp).toBeGreaterThan(0.25);
    // And the gap is the point, not a bug.
    expect(lateRtp).toBeGreaterThan(takeoffRtp);
  });

  describe('C-04 — the open "+" tail bucket', () => {
    const WITH_TAIL: CrashDistribution = { '1-2': 50, '2-5': 30, '5-10': 15, '10+': 5 };

    it('never produces a non-finite crash point from a "+" bucket', () => {
      for (const raw of [1.0, 1.5, 2.7, 9.99, 10.01, 99, 1e9]) {
        const cp = remapCrashPoint(raw, WITH_TAIL);
        expect(Number.isFinite(cp)).toBe(true);
        expect(cp).toBeGreaterThanOrEqual(1);
      }
      const WITH_BARE: CrashDistribution = { '1-2': 90, '+': 10 };
      for (const raw of [1.0, 2.7, 99]) {
        expect(Number.isFinite(remapCrashPoint(raw, WITH_BARE))).toBe(true);
      }
    });

    it('generator and pricing curve agree on the "+" tail (no arbitrage)', () => {
      expect(survival(1, WITH_TAIL)).toBeGreaterThan(0.9);
      expect(survival(10, WITH_TAIL)).toBeLessThan(0.25);
      // crashTailUpper(10, Infinity) = max(110, 30) = 110 — nothing pays past it.
      expect(survival(110.5, WITH_TAIL)).toBe(0);
      // Mid-flight cashouts deeper than the financable ceiling refund the stake
      // (multiple = 1) instead of printing an infinite payout.
      const m = midFlightPayoutMultiple(10, 500, WITH_TAIL);
      expect(Number.isFinite(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(1);
    });

    it('RTP stays in the financed band with a "+" tail configured', () => {
      let staked = 0;
      let returned = 0;
      const rnd = mulberry32(0xdeadbeef);
      for (let i = 0; i < 200_000; i++) {
        const cp = remapCrashPoint(0.96 / Math.max(1e-6, 1 - rnd()), WITH_TAIL);
        expect(Number.isFinite(cp)).toBe(true);
        const betAt = 1 + rnd() * 2;
        if (cp < betAt) continue;
        const target = betAt + 1 + rnd();
        const mult = midFlightPayoutMultiple(betAt, target, WITH_TAIL);
        staked += 1;
        if (cp >= target) returned += mult;
      }
      const rtp = returned / Math.max(1, staked);
      expect(rtp).toBeLessThan(1.0); // house never pays >100% — not even via the tail
    });
  });

  function mulberry32(a: number) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
});
