// apps/api/src/engine/session/ladders.test.ts — session-game ladders must be
// fair at EVERY cash-out point, not just the first few rungs.
//
// The shipped ladders were hand-written tables that drifted badly from the real
// odds:
//   mines  10 mines, 10 safe digs -> paid 3750x where fair is 1044.96x (344% RTP)
//   mines  ladders were also truncated (10 rungs for 15 safe tiles)
//   tower  hard/expert flatlined at 100x -> floor 10 was 0.01% / 0.00% RTP
//   stairs flatlined at 100x from step 7 -> last step was 9.8% RTP
import { describe, it, expect } from 'vitest';
import { minesLadder, towerLadder, stairsLadder2 } from './gameSessions';

/** C(n, k) without overflow for our small n. */
function survivalMines(k: number, mines: number): number {
  // probability of digging k safe tiles in a row on a 25-tile board
  let p = 1;
  for (let j = 0; j < k; j++) p *= (25 - mines - j) / (25 - j);
  return p;
}

describe('mines ladder', () => {
  it('has one rung per safe tile (no truncation)', () => {
    for (const m of [1, 3, 5, 10, 15, 24]) {
      expect(minesLadder(m).length).toBe(25 - m);
    }
  });

  it('pays exactly 96% RTP at every cash-out point', () => {
    for (const m of [1, 2, 3, 5, 10, 15, 24]) {
      const ladder = minesLadder(m);
      ladder.forEach((mult, i) => {
        const k = i + 1;
        const rtp = mult * survivalMines(k, m);
        expect(rtp).toBeGreaterThan(0.94);
        expect(rtp).toBeLessThan(0.98);
      });
    }
  });

  it('never exceeds 100% RTP (the 344% overpay bug)', () => {
    for (const m of [1, 3, 5, 10, 24]) {
      minesLadder(m).forEach((mult, i) => {
        expect(mult * survivalMines(i + 1, m)).toBeLessThanOrEqual(1.0);
      });
    }
  });

  it('is strictly increasing — every extra dig must pay more', () => {
    for (const m of [1, 3, 5, 10]) {
      const l = minesLadder(m);
      for (let i = 1; i < l.length; i++) expect(l[i]!).toBeGreaterThan(l[i - 1]!);
    }
  });
});

describe('tower ladder', () => {
  const diffs: Array<[string, number, number]> = [
    ['easy', 3, 1],
    ['medium', 4, 2],
    ['hard', 4, 3],
    ['expert', 5, 4],
  ];

  it('pays ~96% RTP on every floor for every difficulty', () => {
    for (const [, cols, traps] of diffs) {
      const p = (cols - traps) / cols;
      towerLadder(cols, traps).forEach((mult, i) => {
        const rtp = mult * Math.pow(p, i + 1);
        expect(rtp).toBeGreaterThan(0.94);
        expect(rtp).toBeLessThan(0.98);
      });
    }
  });

  it('does not flatline (the 0.01% RTP bug)', () => {
    for (const [, cols, traps] of diffs) {
      const l = towerLadder(cols, traps);
      for (let i = 1; i < l.length; i++) expect(l[i]!).toBeGreaterThan(l[i - 1]!);
      // hard floor 10 used to pay 100x against a fair 1,006,632x
      if (cols === 4 && traps === 3) expect(l[9]!).toBeGreaterThan(900_000);
    }
  });

  it('harder difficulties pay more per floor', () => {
    expect(towerLadder(5, 4)[0]!).toBeGreaterThan(towerLadder(3, 1)[0]!);
  });
});

describe('stairs ladder', () => {
  it('pays ~96% RTP at every step', () => {
    for (const [choices, safe] of [
      [2, 1],
      [3, 1],
      [3, 2],
      [4, 1],
    ] as Array<[number, number]>) {
      const p = safe / choices;
      stairsLadder2(choices, safe).forEach((mult, i) => {
        const rtp = mult * Math.pow(p, i + 1);
        expect(rtp).toBeGreaterThan(0.94);
        expect(rtp).toBeLessThan(0.98);
      });
    }
  });

  it('does not flatline at 100x from step 7', () => {
    const l = stairsLadder2(2, 1);
    for (let i = 1; i < l.length; i++) expect(l[i]!).toBeGreaterThan(l[i - 1]!);
    expect(l[9]!).toBeGreaterThan(900); // fair is 983.04x; the old table paid 100x
  });
});
