// apps/api/src/engine/games/wheel-tiers.test.ts — the wheel/ring are real bets now.
//
// Both games used to ignore `choices` entirely, so there was no decision and no
// way to be right or wrong. These tests lock in that (a) the player's pick
// actually decides the outcome, and (b) every tier returns the same ~96%, so no
// tier is a trap.
import { describe, it, expect } from 'vitest';
import { WheelGame, buildRim, tierPayout, defaultTiers } from './WheelGame';
import { RingOfFortuneGame, defaultRingTiers } from './RingOfFortuneGame';
import { GameConfig } from '../../generated/prisma/client';

const cfg = (tiers: unknown, max = 100) =>
  ({ maxWinMultiplier: max, configJson: { tiers } }) as unknown as GameConfig;

describe('rim construction', () => {
  it('has exactly the declared number of slices per tier', () => {
    for (const tiers of [defaultTiers(), defaultRingTiers()]) {
      const rim = buildRim(tiers);
      expect(rim.length).toBe(tiers.reduce((s, t) => s + t.slices, 0));
      for (const t of tiers) {
        expect(rim.filter((x) => x === t.id).length).toBe(t.slices);
      }
    }
  });

  it('spreads rare tiers out instead of bunching them together', () => {
    const rim = buildRim(defaultRingTiers());
    const goldPositions = rim
      .map((x, i) => (x === 'gold' ? i : -1))
      .filter((i) => i >= 0);
    // 6 gold slices on a 36-slice ring should not all be adjacent
    const span = Math.max(...goldPositions) - Math.min(...goldPositions);
    expect(span).toBeGreaterThan(6);
  });
});

describe('payouts are fair for every tier', () => {
  it('wheel: each tier returns ~96%', () => {
    const tiers = defaultTiers();
    const total = tiers.reduce((s, t) => s + t.slices, 0);
    for (const t of tiers) {
      const rtp = tierPayout(t, total) * (t.slices / total);
      expect(rtp).toBeGreaterThan(0.94);
      expect(rtp).toBeLessThan(0.98);
    }
  });

  it('ring: each tier returns ~96%', () => {
    const tiers = defaultRingTiers();
    const total = tiers.reduce((s, t) => s + t.slices, 0);
    for (const t of tiers) {
      const rtp = tierPayout(t, total) * (t.slices / total);
      expect(rtp).toBeGreaterThan(0.94);
      expect(rtp).toBeLessThan(0.98);
    }
  });

  it('rarer tiers pay strictly more', () => {
    const tiers = defaultRingTiers();
    const total = tiers.reduce((s, t) => s + t.slices, 0);
    const pays = tiers.map((t) => tierPayout(t, total));
    for (let i = 1; i < pays.length; i++)
      expect(pays[i]!).toBeGreaterThan(pays[i - 1]!);
  });
});

describe('the player pick decides the outcome', () => {
  const game = new WheelGame();
  const tiers = defaultTiers();

  it('measured RTP matches the tier payout for every tier', () => {
    const N = 20_000;
    for (const t of tiers) {
      let paid = 0;
      for (let i = 0; i < N; i++) {
        const r = game.resolve({
          rawOutcome: i / N,
          config: cfg(tiers),
          choices: { tier: t.id },
          isWin: true,
          forceMode: 'NONE',
        });
        paid += r.payoutMultiplier;
      }
      const rtp = paid / N;
      expect(rtp).toBeGreaterThan(0.9);
      expect(rtp).toBeLessThan(1.02);
    }
  });

  it('backing a different tier on the SAME spin changes the result', () => {
    // find a spin where the two picks disagree — proves the choice matters
    let differed = false;
    for (let i = 0; i < 200 && !differed; i++) {
      const raw = i / 200;
      const a = game.resolve({
        rawOutcome: raw,
        config: cfg(tiers),
        choices: { tier: 'yellow' },
        isWin: true,
        forceMode: 'NONE',
      });
      const b = game.resolve({
        rawOutcome: raw,
        config: cfg(tiers),
        choices: { tier: 'blue' },
        isWin: true,
        forceMode: 'NONE',
      });
      if (a.result !== b.result) differed = true;
    }
    expect(differed).toBe(true);
  });

  it('the wheel stops in the same place regardless of what you backed', () => {
    // the spin is provably fair: your pick must not move the wheel
    const a = game.resolve({
      rawOutcome: 0.37,
      config: cfg(tiers),
      choices: { tier: 'yellow' },
      isWin: true,
      forceMode: 'NONE',
    });
    const b = game.resolve({
      rawOutcome: 0.37,
      config: cfg(tiers),
      choices: { tier: 'purple' },
      isWin: true,
      forceMode: 'NONE',
    });
    const ia = (a.mappedOutcome as { index: number }).index;
    const ib = (b.mappedOutcome as { index: number }).index;
    expect(ia).toBe(ib);
  });

  it('M-02: a missing/unknown tier REJECTS the bet (was: silent loss of the stake)', () => {
    // There is no noPick refund path in the engine — settling a phantom tier as
    // LOSE kept the stake. Rejection throws through the accept-settle tx,
    // rolling the debit back entirely.
    for (const choices of [{}, { tier: 'platinum' }] as const) {
      expect(() =>
        game.resolve({
          rawOutcome: 0.5,
          config: cfg(tiers),
          choices,
          isWin: true,
          forceMode: 'NONE',
        } as never)
      ).toThrow(/Unknown wheel tier/);
    }
  });

  it('FORCE_WIN lands on the backed tier; FORCE_LOSE avoids it', () => {
    const w = game.resolve({
      rawOutcome: 0.5,
      config: cfg(tiers),
      choices: { tier: 'purple' },
      isWin: true,
      forceMode: 'FORCE_WIN',
    });
    expect(w.result).toBe('WIN');
    const l = game.resolve({
      rawOutcome: 0.5,
      config: cfg(tiers),
      choices: { tier: 'yellow' },
      isWin: true,
      forceMode: 'FORCE_LOSE',
    });
    expect(l.result).toBe('LOSE');
  });

  it('ring: the jackpot tier is reachable and pays the top multiplier', () => {
    const ring = new RingOfFortuneGame();
    const rtiers = defaultRingTiers();
    let hit = false;
    for (let i = 0; i < 400 && !hit; i++) {
      const r = ring.resolve({
        rawOutcome: i / 400,
        config: cfg(rtiers),
        choices: { tier: 'jackpot' },
        isWin: true,
        forceMode: 'NONE',
      });
      if (r.result === 'WIN') {
        hit = true;
        expect(r.payoutMultiplier).toBeCloseTo(34.56, 1);
      }
    }
    expect(hit).toBe(true);
  });
});
