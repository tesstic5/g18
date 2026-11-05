// apps/api/src/engine/games/plinko.test.ts — Galton-board physics + RTP.
//
// The bucket used to be picked UNIFORMLY over rows+1 slots. Real Plinko is
// binomial: the ball makes one left/right choice per peg row. On a 16-row board
// the uniform picker hit an edge jackpot 5.88% of the time instead of 0.0015% —
// ~3,855x too often — and the animation had to teleport the ball to a slot the
// pegs would never lead to. These tests lock in the corrected physics.
import { describe, it, expect } from 'vitest';
import { PlinkoGame, dropBall, slotProbabilities, defaultTable } from './PlinkoGame';
import { plinkoBallCount, plinkoChargedStake } from '@casino/shared';
import { mulberry32 } from './MinesGame';
import { GameConfig } from '../../generated/prisma/client';

const cfg = (max = 200) =>
  ({
    maxWinMultiplier: max,
    configJson: {
      risk_levels: {
        low: {
          '8': defaultTable('low', 8),
          '12': defaultTable('low', 12),
          '16': defaultTable('low', 16),
        },
        medium: {
          '8': defaultTable('medium', 8),
          '12': defaultTable('medium', 12),
          '16': defaultTable('medium', 16),
        },
        high: {
          '8': defaultTable('high', 8),
          '12': defaultTable('high', 12),
          '16': defaultTable('high', 16),
        },
      },
    },
  }) as unknown as GameConfig;

const game = new PlinkoGame();

describe('plinko — Galton board physics', () => {
  it('slot probabilities are binomial and sum to 1', () => {
    for (const rows of [8, 12, 16]) {
      const p = slotProbabilities(rows);
      expect(p.length).toBe(rows + 1);
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      // centre must be the most likely slot, edges the least
      const centre = p[rows / 2]!;
      expect(centre).toBeGreaterThan(p[0]!);
      expect(p[0]!).toBeCloseTo(p[rows]!, 12); // symmetric
    }
    // the specific number that made the old uniform picker wrong
    expect(slotProbabilities(16)[0]!).toBeCloseTo(1 / 65536, 12);
  });

  it('dropBall returns a path of `rows` flips and bucket = number of rights', () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 200; i++) {
      const { bucket, path } = dropBall(rng, 12);
      expect(path.length).toBe(12);
      expect(bucket).toBe(path.reduce((s: number, x) => s + x, 0));
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThanOrEqual(12);
    }
  });

  it('empirical landing distribution matches the binomial curve', () => {
    const rows = 12;
    const N = 200_000;
    const rng = mulberry32(99);
    const counts = Array.from({ length: rows + 1 }, () => 0);
    for (let i = 0; i < N; i++) counts[dropBall(rng, rows).bucket]! += 1;
    const expected = slotProbabilities(rows);
    for (let i = 0; i <= rows; i++) {
      const obs = counts[i]! / N;
      // generous tolerance — this is a statistical check, not an exact one
      expect(Math.abs(obs - expected[i]!)).toBeLessThan(0.01);
    }
    // the centre slot must dominate, as it does on a real board
    expect(counts[6]!).toBeGreaterThan(counts[0]! * 50);
  });

  it('the ball almost never reaches the jackpot slot (the old bug)', () => {
    const rows = 16;
    const N = 100_000;
    const rng = mulberry32(7);
    let edges = 0;
    for (let i = 0; i < N; i++) {
      const b = dropBall(rng, rows).bucket;
      if (b === 0 || b === rows) edges++;
    }
    // uniform would give ~11.8% of rounds hitting an edge; binomial gives ~0.003%
    expect(edges / N).toBeLessThan(0.001);
  });
});

describe('plinko — payouts', () => {
  it('2x / 6x / 12x ladder on every board — nothing ever exceeds 12x (v1.3.9 operator order)', () => {
    for (const rows of [8, 12, 16]) {
      expect(Math.max(...defaultTable('low', rows))).toBe(2);
      expect(Math.max(...defaultTable('medium', rows))).toBe(6);
      expect(Math.max(...defaultTable('high', rows))).toBe(12);
      for (const risk of ['low', 'medium', 'high']) {
        expect(Math.max(...defaultTable(risk, rows))).toBeLessThanOrEqual(12);
      }
    }
  });

  it('dead centre slots: medium has exactly 1 zero, high exactly 3, low none (v1.3.9)', () => {
    for (const rows of [8, 12, 16]) {
      const mid = rows / 2;
      const low = defaultTable('low', rows);
      expect(low.every((m) => m > 0)).toBe(true);
      const medium = defaultTable('medium', rows);
      expect(medium[mid]!).toBe(0);
      expect(medium.filter((m) => m === 0).length).toBe(1);
      const high = defaultTable('high', rows);
      expect([high[mid - 1]!, high[mid]!, high[mid + 1]!]).toEqual([0, 0, 0]);
      expect(high.filter((m) => m === 0).length).toBe(3);
      // dead slots sit in the most-likely zone — high is genuinely high risk
      const deadP = [mid - 1, mid, mid + 1].reduce(
        (s, i) => s + slotProbabilities(rows)[i]!,
        0
      );
      expect(deadP).toBeGreaterThan(0.5);
    }
  });

  it('RTP per risk level matches the designed bands (low ~96%, medium ~83%, high ~47%)', () => {
    const N = 60_000;
    const BANDS: Record<string, [number, number]> = {
      low: [0.94, 0.98],
      medium: [0.8, 0.86],
      high: [0.45, 0.5],
    };
    const EMPIRICAL: Record<string, [number, number]> = {
      low: [0.9, 1.02],
      medium: [0.74, 0.92],
      high: [0.36, 0.62],
    };
    for (const risk of ['low', 'medium', 'high']) {
      for (const rows of [8, 12, 16]) {
        const table = defaultTable(risk, rows);
        const p = slotProbabilities(rows);
        // exact expected value under the true (binomial) distribution
        const rtp = p.reduce((s, pi, i) => s + pi * table[i]!, 0);
        expect(rtp).toBeGreaterThan(BANDS[risk]![0]);
        expect(rtp).toBeLessThan(BANDS[risk]![1]);
      }
      // and empirically, through the real handler
      let total = 0;
      for (let i = 1; i <= N; i++) {
        const r = game.resolve({
          rawOutcome: i / (N + 1),
          config: cfg(1000),
          choices: { rows: 12, risk, balls: 1 },
          isWin: true,
          forceMode: 'NONE',
        }) as { payoutMultiplier: number };
        total += r.payoutMultiplier;
      }
      expect(total / N).toBeGreaterThan(EMPIRICAL[risk]![0]);
      expect(total / N).toBeLessThan(EMPIRICAL[risk]![1]);
    }
  });

  it('risk levels are actually different games', () => {
    const low = defaultTable('low', 16);
    const high = defaultTable('high', 16);
    // they shipped IDENTICAL tables before this fix
    expect(low).not.toEqual(high);
    expect(high[0]!).toBe(low[0]! * 6); // 12x edge vs 2x (v1.3.9 ladder)
    expect(high[8]!).toBeLessThan(low[8]!); // and far less in the middle
  });

  it('a sub-1x landing is a LOSE, not a WIN — and a 0x dead slot pays NOTHING (v1.3.9)', () => {
    // med-12 buckets 5/7 pay 0.55x (partial loss); the v1.3.9 centre slot 6 pays 0
    let sawPartial = false;
    let sawZero = false;
    for (let i = 1; i < 400; i++) {
      const r = game.resolve({
        rawOutcome: i / 400,
        config: cfg(),
        choices: { rows: 12, risk: 'medium', balls: 1 },
        isWin: true,
        forceMode: 'NONE',
      }) as {
        result: string;
        payoutMultiplier: number;
        mappedOutcome: { partialRefund: boolean };
      };
      if (r.payoutMultiplier === 0) {
        sawZero = true;
        expect(r.result).toBe('LOSE');
        expect(r.mappedOutcome.partialRefund).toBe(false); // no refund — full loss
      }
      if (r.payoutMultiplier > 0 && r.payoutMultiplier < 1) {
        sawPartial = true;
        expect(r.result).toBe('LOSE');
        expect(r.mappedOutcome.partialRefund).toBe(true);
      }
      if (r.payoutMultiplier >= 1) expect(r.result).toBe('WIN');
    }
    expect(sawPartial).toBe(true);
    expect(sawZero).toBe(true); // dead centre really gets hit
  });

  it('N balls at stake S charges S×N (each ball is a full bet, not a slice)', () => {
    expect(plinkoBallCount({ balls: 16 })).toBe(16);
    expect(plinkoBallCount({})).toBe(1);
    expect(plinkoChargedStake(100, { balls: 16 })).toBe(1600);
    expect(plinkoChargedStake(10, { balls: 1 })).toBe(10);
    // 8 balls × 50, average 2x → debit 400, credit 400*2 = 800 = 50 × Σ(2×8)
    expect(plinkoChargedStake(50, { balls: 8 }) * 2).toBe(800);
  });

  it('aggregate multiplier = mean of per-ball multipliers', () => {
    const r = game.resolve({
      rawOutcome: 0.42,
      config: cfg(),
      choices: { rows: 12, risk: 'medium', balls: 8 },
      isWin: true,
      forceMode: 'NONE',
    }) as {
      payoutMultiplier: number;
      mappedOutcome: {
        balls: number;
        buckets: number[];
        bucketMultipliers: number[];
        aggregate: number;
        paths: number[][];
      };
    };
    expect(r.mappedOutcome.balls).toBe(8);
    expect(r.mappedOutcome.buckets.length).toBe(8);
    expect(r.mappedOutcome.paths.length).toBe(8);
    // every ball ships the exact route the server rolled, so the animation can follow it
    r.mappedOutcome.paths.forEach((p, i) => {
      expect(p.length).toBe(12);
      expect(p.reduce((s, x) => s + x, 0)).toBe(r.mappedOutcome.buckets[i]);
    });
    const mean = r.mappedOutcome.bucketMultipliers.reduce((s, m) => s + m, 0) / 8;
    expect(r.mappedOutcome.aggregate).toBeCloseTo(mean, 3);
  });

  it('buckets are deterministic for the same rawOutcome (provably fair replay)', () => {
    const a = game.resolve({
      rawOutcome: 0.123,
      config: cfg(),
      choices: { rows: 12, risk: 'medium', balls: 16 },
      isWin: true,
      forceMode: 'NONE',
    });
    const b = game.resolve({
      rawOutcome: 0.123,
      config: cfg(),
      choices: { rows: 12, risk: 'medium', balls: 16 },
      isWin: true,
      forceMode: 'NONE',
    });
    expect(
      (a as { mappedOutcome: { buckets: number[] } }).mappedOutcome.buckets
    ).toEqual((b as { mappedOutcome: { buckets: number[] } }).mappedOutcome.buckets);
  });

  it('M-02: rejects unpriced boards/risks and out-of-range balls (was: silent re-board)', () => {
    const base = {
      rawOutcome: 0.5,
      config: cfg(),
      isWin: true,
      forceMode: 'NONE',
    } as const;
    // too many balls → REJECT (was silently clamped to 16)
    expect(() =>
      game.resolve({
        ...base,
        choices: { rows: 12, risk: 'medium', balls: 99 },
      } as never)
    ).toThrow(/balls/i);
    // unsupported row count → REJECT (was silently replayed on 12 rows)
    expect(() =>
      game.resolve({ ...base, choices: { rows: 7, risk: 'medium', balls: 1 } } as never)
    ).toThrow(/board size/);
    expect(() =>
      game.resolve({ ...base, choices: { rows: 9, risk: 'medium', balls: 1 } } as never)
    ).toThrow(/board size/);
    // unknown risk → REJECT (was silently replayed as medium)
    expect(() =>
      game.resolve({
        ...base,
        choices: { rows: 12, risk: 'nonsense', balls: 1 },
      } as never)
    ).toThrow(/risk/i);
    // the legit defaults remain accepted
    const ok = game.resolve({ ...base, choices: {} } as never) as {
      mappedOutcome: { rows: number; risk: string };
    };
    expect(ok.mappedOutcome.rows).toBe(12);
    expect(ok.mappedOutcome.risk).toBe('medium');
  });

  it('FORCE_WIN wins, FORCE_LOSE loses', () => {
    const w = game.resolve({
      rawOutcome: 0.5,
      config: cfg(),
      choices: { rows: 12, risk: 'medium', balls: 4 },
      isWin: true,
      forceMode: 'FORCE_WIN',
    }) as { result: string };
    const l = game.resolve({
      rawOutcome: 0.5,
      config: cfg(),
      choices: { rows: 12, risk: 'medium', balls: 4 },
      isWin: true,
      forceMode: 'FORCE_LOSE',
    }) as { result: string };
    expect(w.result).toBe('WIN');
    expect(l.result).toBe('LOSE');
  });
});
