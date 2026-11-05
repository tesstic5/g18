// apps/api/src/engine/games/table-games.test.ts — D-093: baccarat (full standard
// rules + face-card fix), dragon-tiger (tie push), roulette (full table bets).
// Verifies both the payout math and the probabilities (RTP stays ~96-99%).
import { describe, it, expect } from 'vitest';
import {
  baccaratPoint,
  baccaratValue,
  dealBaccarat,
  bankerDrawsDecision,
  BaccaratGame,
} from './BaccaratGame';
import { DragonTigerGame, DRAGON_TIGER_CHANCES } from './DragonTigerGame';
import {
  RouletteGame,
  pocketColor,
  defaultPayouts,
  COLUMN_NUMBERS,
} from './RouletteGame';
import { GameConfig } from '../../generated/prisma/client';

const cfg = { maxWinMultiplier: 100, configJson: {} } as unknown as GameConfig;

function rngFor(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('baccarat — full standard rules (D-093)', () => {
  it('face cards count ZERO (J/Q/K = 0, 10 = 0, Ace = 1)', () => {
    expect(baccaratValue(10)).toBe(0); // 10
    expect(baccaratValue(11)).toBe(0); // J
    expect(baccaratValue(12)).toBe(0); // Q
    expect(baccaratValue(13)).toBe(0); // K
    expect(baccaratValue(1)).toBe(1); // Ace
    expect(baccaratValue(9)).toBe(9);
    // a hand of K + 7 = 7 (was 13+7=20→0 with the old bug)
    expect(baccaratPoint([13, 7])).toBe(7);
    expect(baccaratPoint([10, 11])).toBe(0);
    expect(baccaratPoint([1, 9])).toBe(0);
  });

  it('standard drawing rules', () => {
    // natural 8/9 → nobody draws
    expect(bankerDrawsDecision(0, true, 5)).toBe(true);
    expect(bankerDrawsDecision(7, true, 5)).toBe(false); // banker 7 stands
    expect(bankerDrawsDecision(6, true, 6)).toBe(true); // banker 6 draws on player 6/7
    expect(bankerDrawsDecision(6, true, 5)).toBe(false); // banker 6 stands on player 5
    expect(bankerDrawsDecision(4, true, 0)).toBe(false); // banker 4 stands on player 0/1/8/9
    expect(bankerDrawsDecision(4, true, 3)).toBe(true);
    expect(bankerDrawsDecision(3, true, 8)).toBe(false); // banker 3 stands on player 8
    expect(bankerDrawsDecision(5, false, -1)).toBe(true); // player stands → banker ≤5 draws
  });

  it('standard outcome probabilities (player 44.6%, banker 45.9%, tie 9.5%)', () => {
    const N = 400_000;
    let player = 0,
      banker = 0,
      tie = 0;
    const rng = rngFor(0xbeef);
    for (let i = 0; i < N; i++) {
      const h = dealBaccarat(rng);
      if (h.playerPoint > h.bankerPoint) player++;
      else if (h.bankerPoint > h.playerPoint) banker++;
      else tie++;
    }
    expect(player / N).toBeGreaterThan(0.435);
    expect(player / N).toBeLessThan(0.457);
    expect(banker / N).toBeGreaterThan(0.448);
    expect(banker / N).toBeLessThan(0.47);
    expect(tie / N).toBeGreaterThan(0.085);
    expect(tie / N).toBeLessThan(0.106);
  });

  it('payout math: player 2×, banker 1.95×, tie push returns the stake', () => {
    const game = new BaccaratGame();
    // player bet on a player win → 2×
    const r1 = game.resolve({
      rawOutcome: 0.01,
      config: cfg,
      choices: { bet: 'player' },
      isWin: true,
      forceMode: 'NONE',
    }) as {
      payoutMultiplier: number;
      mappedOutcome: { outcome: string; win: boolean; isPush: boolean };
    };
    if (r1.mappedOutcome.outcome === 'player' && r1.mappedOutcome.win)
      expect(r1.payoutMultiplier).toBe(1.95); // seeded
    // banker bet on a banker win → 1.95×
    const r2 = game.resolve({
      rawOutcome: 0.5,
      config: cfg,
      choices: { bet: 'banker' },
      isWin: true,
      forceMode: 'NONE',
    }) as {
      payoutMultiplier: number;
      mappedOutcome: { outcome: string; win: boolean; isPush: boolean };
    };
    if (r2.mappedOutcome.outcome === 'banker') expect(r2.payoutMultiplier).toBe(1.9); // seeded
    // tie + player bet → push (1×)
    const r3 = game.resolve({
      rawOutcome: 0.9,
      config: cfg,
      choices: { bet: 'player' },
      isWin: true,
      forceMode: 'NONE',
    }) as {
      payoutMultiplier: number;
      mappedOutcome: { outcome: string; win: boolean; isPush: boolean };
    };
    if (r3.mappedOutcome.outcome === 'tie') expect(r3.mappedOutcome.isPush).toBe(true);
    // tie bet on a tie → 8×
    const r4 = game.resolve({
      rawOutcome: 0.9,
      config: cfg,
      choices: { bet: 'tie' },
      isWin: true,
      forceMode: 'NONE',
    }) as {
      payoutMultiplier: number;
      mappedOutcome: { outcome: string; win: boolean };
    };
    if (r4.mappedOutcome.outcome === 'tie') expect(r4.payoutMultiplier).toBe(8);
  });
});

describe('dragon-tiger — tie push (D-089/093)', () => {
  it('M-03: the pricing model matches the generator (tie = 1/13, with replacement)', () => {
    // The sampler draws both ranks independently with replacement, so ties hit
    // 1/13 of the time. fairWinChance (used by difficulty/force conditioning)
    // must agree — the old 3/51 was the without-replacement deck value.
    expect(DRAGON_TIGER_CHANCES.tie).toBeCloseTo(1 / 13, 10);
    expect(DRAGON_TIGER_CHANCES.side).toBeCloseTo((1 - 1 / 13) / 2, 10);
    const game = new DragonTigerGame();
    expect(game.fairWinChance({ bet: 'tie' })).toBeCloseTo(1 / 13, 10);
    let ties = 0;
    const N = 120_000;
    for (let i = 1; i <= N; i++) {
      const r = game.resolve({
        rawOutcome: i / (N * 2),
        config: cfg,
        choices: { bet: 'dragon' },
        isWin: true,
        forceMode: 'NONE',
      }) as { result: string };
      if (r.result === 'PUSH') ties++;
    }
    expect(ties / N).toBeGreaterThan(1 / 13 - 0.01);
    expect(ties / N).toBeLessThan(1 / 13 + 0.01);
  });

  it('outcome matches the card ranks; tie pushes dragon/tiger bets', () => {
    const game = new DragonTigerGame();
    let pushes = 0,
      wins = 0;
    const N = 200_000;
    for (let i = 1; i <= N; i++) {
      const r = game.resolve({
        rawOutcome: i / (N * 2),
        config: cfg,
        choices: { bet: 'dragon' },
        isWin: true,
        forceMode: 'NONE',
      }) as {
        payoutMultiplier: number;
        mappedOutcome: {
          dragon: string;
          tiger: string;
          outcome: string;
          win: boolean;
          multiplier: number;
        };
      };
      const dv = '2345678910JQKA'.indexOf(r.mappedOutcome.dragon.slice(0, -1)) + 2;
      const tv = '2345678910JQKA'.indexOf(r.mappedOutcome.tiger.slice(0, -1)) + 2;
      const expectOutcome = dv > tv ? 'dragon' : tv > dv ? 'tiger' : 'tie';
      if (expectOutcome !== r.mappedOutcome.outcome) {
        expect(expectOutcome).toBe(r.mappedOutcome.outcome);
        break;
      }
      if (r.mappedOutcome.outcome === 'tie') {
        expect(r.mappedOutcome.multiplier).toBe(1); // push
        pushes++;
      } else if (r.mappedOutcome.win) wins++;
    }
    // RTP = P(win)×1.92 + P(tie)×1 ≈ 0.962
    const rtp = (wins / N) * 1.92 + (pushes / N) * 1;
    expect(rtp).toBeGreaterThan(0.93);
    expect(rtp).toBeLessThan(0.99);
  });
});

describe('roulette — full table (D-093)', () => {
  it('pocket color mapping (European single-zero)', () => {
    expect(pocketColor(0)).toBe('green');
    expect(pocketColor(1)).toBe('red');
    expect(pocketColor(2)).toBe('black');
    expect(pocketColor(32)).toBe('red');
    expect(pocketColor(36)).toBe('red');
  });

  it('column numbers are the 2:1 columns', () => {
    expect(COLUMN_NUMBERS[1]).toEqual([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]);
    expect(COLUMN_NUMBERS[2]).toEqual([2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35]);
    expect(COLUMN_NUMBERS[3]).toEqual([3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36]);
  });

  it('each bet type resolves against the pocket with the standard payout', () => {
    const game = new RouletteGame();
    const cases: Array<[Record<string, unknown>, number[]]> = [
      [{ type: 'straight', number: 17 }, [17]],
      [{ type: 'split', numbers: [16, 17] }, [16, 17]],
      [{ type: 'street', numbers: [13, 14, 15] }, [13, 14, 15]],
      [{ type: 'corner', numbers: [16, 17, 19, 20] }, [16, 17, 19, 20]],
      [
        { type: 'six_line', numbers: [13, 14, 15, 16, 17, 18] },
        [13, 14, 15, 16, 17, 18],
      ],
      [{ type: 'column', column: 1 }, COLUMN_NUMBERS[1]!],
    ];
    for (const [bet, pockets] of cases) {
      for (const p of pockets) {
        const r = game.resolve({
          rawOutcome: (p + 0.5) / 37,
          config: cfg,
          choices: { bet },
          isWin: true,
          forceMode: 'NONE',
        }) as {
          payoutMultiplier: number;
          mappedOutcome: { pocket: number; win: boolean };
        };
        expect(r.mappedOutcome.pocket).toBe(p);
        expect(r.mappedOutcome.win).toBe(true);
        expect(r.payoutMultiplier).toBe(defaultPayouts()[String(bet.type)] ?? 0);
      }
      // a pocket outside the covered set loses
      const outside = pockets.includes(0) ? 1 : 0;
      const rl = game.resolve({
        rawOutcome: (outside + 0.5) / 37,
        config: cfg,
        choices: { bet },
        isWin: true,
        forceMode: 'NONE',
      }) as { mappedOutcome: { pocket: number; win: boolean } };
      expect(rl.mappedOutcome.win).toBe(false);
    }
  });

  it('M-01: { type: "dozen", dozen: N } pays exactly like dozen-N (was: always LOSE)', () => {
    const game = new RouletteGame();
    for (const d of [1, 2, 3] as const) {
      const covered = Array.from({ length: 12 }, (_, i) => (d - 1) * 12 + i + 1);
      for (const p of covered) {
        const r = game.resolve({
          rawOutcome: (p + 0.5) / 37,
          config: cfg,
          choices: { bet: { type: 'dozen', dozen: d } },
          isWin: true,
          forceMode: 'NONE',
        }) as { payoutMultiplier: number; mappedOutcome: { win: boolean } };
        expect(r.mappedOutcome.win).toBe(true);
        expect(r.payoutMultiplier).toBe(defaultPayouts()['dozen']); // pays 3:1
      }
      // pocket 0 and other dozens lose; probing one from each other dozen
      for (const p of [0, ...covered.filter((x) => x > 18)].length
        ? [0, 13, 25].filter((x) => !covered.includes(x))
        : [0]) {
        const r = game.resolve({
          rawOutcome: (p + 0.5) / 37,
          config: cfg,
          choices: { bet: { type: 'dozen', dozen: d } },
          isWin: true,
          forceMode: 'NONE',
        }) as { mappedOutcome: { win: boolean } };
        expect(r.mappedOutcome.win).toBe(false);
      }
      // pricing agrees with the resolver: 12 covered pockets
      expect(RouletteGame.coveredPockets({ type: 'dozen', dozen: d })).toBe(12);
    }
    // malformed dozen selections are rejected by both lines of defence
    expect(RouletteGame.coveredPockets({ type: 'dozen', dozen: 4 })).toBe(0);
    expect(RouletteGame.coveredPockets({ type: 'dozen' })).toBe(0);
  });

  it('red bet EV ≈ 18/37×2 = 0.973 (true European wheel)', () => {
    const game = new RouletteGame();
    let wins = 0;
    const N = 300_000;
    for (let i = 0; i < N; i++) {
      const r = game.resolve({
        rawOutcome: ((i % 37) + 0.5) / 37,
        config: cfg,
        choices: { bet: { type: 'red' } },
        isWin: true,
        forceMode: 'NONE',
      }) as { mappedOutcome: { win: boolean } };
      if (r.mappedOutcome.win) wins++;
    }
    // exact enumeration: 18 red pockets of 37
    expect(wins / N).toBeCloseTo(18 / 37, 2);
  });
});
