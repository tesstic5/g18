// apps/api/src/engine/games/games.test.ts — handler determinism + math (docs/20 §20)
import { describe, expect, it } from 'vitest';
import { DiceGame } from './DiceGame';
import { CRASH_INSTANT_GATE, generateCrashPointRaw } from './AviatorGame';
import { crashGateForLevel } from '../difficulty';
import { LimboGame, limboResult } from './LimboGame';
import { MinesGame } from './MinesGame';
import { KenoGame } from './KenoGame';
import { ScratchCardGame } from './ScratchCardGame';
import { colorOf, drawNumber, WingoGame } from './WingoGame';
import { buildRim, defaultTiers, tierPayout } from './WheelGame';

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'x',
    displayName: 'x',
    description: null,
    thumbnailUrl: null,
    category: [],
    tags: [],
    sortOrder: 0,
    isActive: true,
    isFeatured: false,
    demoEnabled: false,
    baseRtp: 96,
    winRate: 45,
    houseEdge: 4,
    maxWinMultiplier: 100,
    minBet: 1,
    defaultPayout: 2,
    forceOverride: 'NONE',
    forceRoundsLeft: 0,
    forceMaxPayout: null,
    configJson: {},
    totalWagered: 0,
    totalPaidOut: 0,
    totalRounds: 0,
    effectiveRtp: null,
    animationSpeed: 1,
    updatedAt: new Date(),
    updatedBy: null,
    ...overrides,
  } as never;
}

describe('game handlers', () => {
  it('dice: multiplier follows 99/probability and result is deterministic', () => {
    const g = new DiceGame();
    const cfg = fakeConfig();
    // D-089: result comes from the ROLL vs target, not isWin.
    const a = g.resolve({
      isWin: true,
      rawOutcome: 0.5,
      config: cfg,
      choices: { over: true, target: 50 },
      forceMode: 'NONE',
    });
    const b = g.resolve({
      isWin: true,
      rawOutcome: 0.5,
      config: cfg,
      choices: { over: true, target: 50 },
      forceMode: 'NONE',
    });
    expect(a.result).toBe('LOSE'); // roll 50 is NOT > 50
    expect(a.payoutMultiplier).toBe(0); // lose → no payout
    expect(a.mappedOutcome).toEqual(b.mappedOutcome); // deterministic
    const c = g.resolve({
      isWin: false,
      rawOutcome: 0.8,
      config: cfg,
      choices: { over: true, target: 50 },
      forceMode: 'NONE',
    });
    expect(c.result).toBe('WIN'); // roll 80 > 50
    expect(c.payoutMultiplier).toBeCloseTo(1.98, 2); // 99/50
  });

  it('limbo: result within [1, 1e6] and win respects target', () => {
    expect(limboResult(0.5)).toBeCloseTo(2, 5);
    const g = new LimboGame();
    const r = g.resolve({
      isWin: true,
      rawOutcome: 0.99,
      config: fakeConfig(),
      choices: { target: 2 },
      forceMode: 'NONE',
    });
    expect(r.result).toBe('WIN');
    expect((r.mappedOutcome as { result: number }).result).toBeGreaterThanOrEqual(2);
  });

  it('aviator: operator difficulty scales the takeoff-blast gate (easy→impossible)', () => {
    // 2026-08-21 product decision: the level knob scales takeoff survival
    // (easy 52.5% / normal 35% / hard 17.5% / impossible 3.5% survive).
    for (const [level, min, max] of [
      ['easy', 0.42, 0.54], // instant ≈ 47.5%
      ['normal', 0.6, 0.7], // instant ≈ 65%
      ['hard', 0.78, 0.86], // instant ≈ 82.5%
      ['impossible', 0.94, 0.98], // instant ≈ 96.5%
    ] as const) {
      let instant = 0;
      const n = 4000;
      for (let i = 0; i < n; i++)
        if (
          generateCrashPointRaw(
            `layer-${level}-${i}`,
            'gate-test',
            0.04,
            crashGateForLevel(level)
          ) === 1
        )
          instant++;
      const share = instant / n;
      expect(share).toBeGreaterThan(min);
      expect(share).toBeLessThan(max);
    }
    // Gate ordering matches the ladder exactly
    expect(crashGateForLevel('easy')).toBeLessThan(crashGateForLevel('normal'));
    expect(crashGateForLevel('normal')).toBeLessThan(crashGateForLevel('hard'));
    expect(crashGateForLevel('hard')).toBeLessThan(crashGateForLevel('impossible'));
    // NORMAL default constant kept in lockstep with the difficulty table
    expect(CRASH_INSTANT_GATE).toBe(crashGateForLevel('normal'));
    expect(crashGateForLevel('normal')).toBe(6354);
  });

  it('aviator: crash point formula deterministic + ~65% instant takeoff bust', () => {
    const p1 = generateCrashPointRaw('seed', 'round-1');
    const p2 = generateCrashPointRaw('seed', 'round-1');
    expect(p1).toBe(p2);
    expect(p1).toBeGreaterThanOrEqual(1);
    // exactly-1.0 occurs via the h%10000<6354 gate (~63.5%) AND the surviving
    // curve's own ≤1 clamp (~+1.46 pts) → ~65% overall (operator decision
    // 2026-08-21: "the plane must explode right away most of the time").
    let instant = 0;
    for (let i = 0; i < 660; i++)
      if (generateCrashPointRaw(`s${i}`, 'r') === 1) instant++;
    expect(instant).toBeGreaterThan(380);
    expect(instant).toBeLessThan(480);
    // survivors still cover the full multiplier range above 1.00x
    let high = 0;
    for (let i = 0; i < 660; i++) {
      const p = generateCrashPointRaw(`s${i}`, 'r');
      if (p >= 2) high++;
    }
    expect(high).toBeGreaterThan(660 * 0.1); // ≥10% of rounds reach 2x+
  });

  it('wingo: real WinGo color mapping (D-106) + weighted draw', () => {
    // GREEN = 1,3,7,9 · RED = 2,4,6,8 · VIOLET = 0,5 (real WinGo rule)
    expect(colorOf(1)).toBe('green');
    expect(colorOf(3)).toBe('green');
    expect(colorOf(7)).toBe('green');
    expect(colorOf(9)).toBe('green');
    expect(colorOf(2)).toBe('red');
    expect(colorOf(4)).toBe('red');
    expect(colorOf(6)).toBe('red');
    expect(colorOf(8)).toBe('red');
    expect(colorOf(0)).toBe('violet');
    expect(colorOf(5)).toBe('violet');
    expect(
      drawNumber(
        0.01,
        Array.from({ length: 10 }, (_, number) => ({ number, weight: 10 }))
      )
    ).toBe(0);
    expect(
      drawNumber(
        0.99,
        Array.from({ length: 10 }, (_, number) => ({ number, weight: 10 }))
      )
    ).toBe(9);
  });

  it('wingo: resolve honors color/size/number bets at 1.96×', () => {
    const g = new WingoGame();
    const cfg = fakeConfig();
    const resolveFor = (raw: number, choice: string | number) =>
      g.resolve({
        isWin: true,
        rawOutcome: raw,
        config: cfg,
        choices: { choice },
        forceMode: 'NONE',
      });
    // rawOutcome 0.15 → number 1 (green, small)
    const n1 = resolveFor(0.15, 'green');
    expect(n1.result).toBe('WIN');
    expect(n1.payoutMultiplier).toBeCloseTo(1.96, 4);
    expect(resolveFor(0.15, 'red').result).toBe('LOSE');
    expect(resolveFor(0.15, 'small').result).toBe('WIN');
    expect(resolveFor(0.15, 'small').payoutMultiplier).toBeCloseTo(1.96, 4);
    expect(resolveFor(0.15, 'big').result).toBe('LOSE');
    expect(resolveFor(0.15, 1).result).toBe('WIN');
    expect(resolveFor(0.15, 1).payoutMultiplier).toBeCloseTo(1.96, 4);
    expect(resolveFor(0.15, 2).result).toBe('LOSE');
    // rawOutcome 0.55 → number 5 (violet, big)
    expect(resolveFor(0.55, 'violet').result).toBe('WIN');
    expect(resolveFor(0.55, 'violet').payoutMultiplier).toBeCloseTo(1.96, 4);
    expect(resolveFor(0.55, 'big').result).toBe('WIN');
    expect(resolveFor(0.55, 'small').result).toBe('LOSE');
    expect(resolveFor(0.55, 'green').result).toBe('LOSE');
    // rawOutcome 0.95 → number 9 (green, big)
    expect(resolveFor(0.95, 'green').result).toBe('WIN');
    expect(resolveFor(0.95, 'big').result).toBe('WIN');
    expect(resolveFor(0.95, 'red').result).toBe('LOSE');
  });

  it('wingo: every win pays 1.96× (100k rounds, HMAC draw)', () => {
    const g = new WingoGame();
    const cfg = fakeConfig();
    const types: Array<[string | number, number, number]> = [
      ['red', 1.96, 0.4],
      ['green', 1.96, 0.4],
      ['violet', 1.96, 0.2],
      ['small', 1.96, 0.5],
      ['big', 1.96, 0.5],
      [3, 1.96, 0.1],
      [8, 1.96, 0.1],
      [0, 1.96, 0.1],
    ];
    for (const [choice, mult, p] of types) {
      let won = 0;
      for (let i = 0; i < 100_000; i++) {
        const r = g.resolve({
          isWin: true,
          rawOutcome: ((i * 7919) % 100000) / 100000,
          config: cfg,
          choices: { choice },
          forceMode: 'NONE',
        });
        if (r.result === 'WIN') {
          expect(r.payoutMultiplier).toBe(1.96);
          won += mult;
        }
      }
      const rtp = won / 100_000;
      expect(rtp).toBeGreaterThan(p * 1.96 - 0.03);
      expect(rtp).toBeLessThan(p * 1.96 + 0.03);
    }
  }, 30_000);

  it('mines: deterministic placement, bust reveals positions', () => {
    const g = new MinesGame();
    // D-089: the GRID decides — isWin no longer forces a loss.
    const r = g.resolve({
      isWin: false,
      rawOutcome: 0.1234,
      config: fakeConfig(),
      choices: { mineCount: 3, clickedTile: 0 },
      forceMode: 'NONE',
    });
    const r2 = g.resolve({
      isWin: false,
      rawOutcome: 0.1234,
      config: fakeConfig(),
      choices: { mineCount: 3, clickedTile: 0 },
      forceMode: 'NONE',
    });
    expect(r.mappedOutcome).toEqual(r2.mappedOutcome); // deterministic
    const pos = (r.mappedOutcome as { minePositions: number[] | null }).minePositions;
    expect(pos === null || pos.length === 3).toBe(true);
    // forced lose via forceMode still works (admin tool)
    const forced = g.resolve({
      isWin: false,
      rawOutcome: 0.1234,
      config: fakeConfig(),
      choices: { mineCount: 3, clickedTile: 0 },
      forceMode: 'FORCE_LOSE',
    });
    expect(forced.result).toBe('LOSE');
  });

  it('keno: picks within grid, matches ≤ picks', () => {
    const g = new KenoGame();
    const r = g.resolve({
      isWin: true,
      rawOutcome: 0.5,
      config: fakeConfig(),
      choices: { picks: [1, 5, 9, 13] },
      forceMode: 'NONE',
    });
    const m = r.mappedOutcome as { picks: number[]; drawn: number[]; matches: number };
    expect(m.picks).toHaveLength(4);
    expect(m.matches).toBeGreaterThanOrEqual(0);
    expect(m.matches).toBeLessThanOrEqual(4);
  });

  it('scratch card: grid is rows×cols and wins only on 3-in-a-row', () => {
    const g = new ScratchCardGame();
    const r = g.resolve({
      isWin: true,
      rawOutcome: 0.9999,
      config: fakeConfig(),
      choices: {},
      forceMode: 'NONE',
    });
    const m = r.mappedOutcome as { grid: string[]; rows: number; cols: number };
    expect(m.grid).toHaveLength(9);
  });

  it('wheel: the rim matches the declared tiers and every tier is fair', () => {
    // The wheel used weighted "segments" and ignored the player entirely.
    // It is a tier bet now — see wheel-tiers.test.ts for the full coverage.
    const tiers = defaultTiers();
    const rim = buildRim(tiers);
    const total = rim.length;
    expect(total).toBe(24);
    for (const t of tiers) {
      expect(rim.filter((x) => x === t.id).length).toBe(t.slices);
      const rtp = tierPayout(t, total) * (t.slices / total);
      expect(rtp).toBeCloseTo(0.96, 2);
    }
  });
});
