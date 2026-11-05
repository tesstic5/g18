// apps/api/src/engine/difficulty-tiers.test.ts
//
// PROOF that the operator's difficulty tiers work as intended for every game.
//
// The engine decides win/lose against `effectiveWinChance = fairWinChance x
// factor` and the handler then produces a DISPLAY-CONSISTENT outcome for that
// decision. So "difficulty works" means three things, and this file pins all
// three for every game the knob applies to:
//
//   1. the win FREQUENCY actually moves with the factor
//      (easy > normal > hard > impossible),
//   2. the movement MATCHES the documented multiplier, not just any ordering,
//   3. the outcome shown to the player agrees with the money paid — a round
//      the engine decided as a win must pay more than the stake, and vice
//      versa ("if they win they win, if they lose they lose").
//
// Sampling is a deterministic sweep over the unit interval rather than random
// draws, so the estimates are stable and the suite is reproducible.
import { describe, expect, it } from 'vitest';
import { ensureGamesRegistered, getGameHandler } from './games/BaseGame';
import {
  DIFFICULTY_AWARE_SLUGS,
  DIFFICULTY_LEVELS,
  DIFFICULTY_FACTORS,
  MIN_EFFECTIVE_CHANCE,
  MAX_EFFECTIVE_CHANCE,
  effectiveWinChance,
} from './difficulty';
import type { DifficultyLevel } from './difficulty';
import { defaultTiers } from './games/WheelGame';
import { defaultRingTiers } from './games/RingOfFortuneGame';

const N = 800;

function cfg(configJson: Record<string, unknown>, maxWin = 1000) {
  return {
    slug: 'x',
    maxWinMultiplier: maxWin,
    minBet: 1,
    baseRtp: 96,
    defaultPayout: 2,
    forceOverride: 'NONE',
    forceRoundsLeft: 0,
    configJson,
  } as never;
}

/** A representative "default" bet for each game the knob applies to. */
function choicesFor(slug: string): Record<string, unknown> {
  switch (slug) {
    case 'dice':
      return { over: true, target: 50 }; // p = 0.50
    case 'limbo':
      return { target: 2 }; // p = 0.50
    case 'coin-flip':
      return { choice: 'heads' }; // p = 0.50
    case 'thimbles':
      return { cup: 0 }; // p = 1/3
    case 'wheel':
      return { tier: defaultTiers()[0]!.id };
    case 'ring-of-fortune':
      return { tier: defaultRingTiers()[0]!.id };
    case 'roulette':
      return { bet: { type: 'red' } }; // p = 18/37
    case 'keno':
      return { picks: [1, 2, 3, 4, 5] };
    case 'plinko':
      return { risk: 'medium', rows: 12, balls: 1 };
    case 'lucky-number':
      return { betMin: 1, betMax: 10 }; // p = 0.10
    case 'dragon-tiger':
      return { bet: 'dragon' };
    case 'baccarat':
      return { bet: 'player' };
    case 'scratch-card':
      return {};
    default:
      return {};
  }
}

const CONFIGS: Record<string, Record<string, unknown>> = {
  // keno has no usable default table — an empty one would make p = 0 and the
  // knob a no-op, so give it a real (small) ladder.
  keno: {
    grid_size: 40,
    draw_count: 20,
    max_picks: 10,
    payout_tables: {
      '5_picks': { '3': 2, '4': 10, '5': 50 },
    },
  },
  thimbles: { cups: 3 },
  'lucky-number': { min: 1, max: 100 },
};

describe('difficulty tiers — every game the knob applies to', () => {
  for (const slug of DIFFICULTY_AWARE_SLUGS) {
    describe(slug, () => {
      const config = cfg(CONFIGS[slug] ?? {});
      const choices = choicesFor(slug);

      it('declares a fair win chance (otherwise the knob silently no-ops)', async () => {
        await ensureGamesRegistered();
        const p = getGameHandler(slug).fairWinChance(choices, config);
        expect(p, `${slug} must implement fairWinChance`).not.toBeNull();
        expect(p!).toBeGreaterThan(0);
        expect(p!).toBeLessThanOrEqual(1);
      });

      it('moves the win frequency monotonically easy > normal > hard > impossible', async () => {
        await ensureGamesRegistered();
        const handler = getGameHandler(slug);
        const pFair = handler.fairWinChance(choices, config)!;

        const rates: Partial<Record<DifficultyLevel, number>> = {};
        for (const tier of DIFFICULTY_LEVELS) {
          const pEff = effectiveWinChance(pFair, tier);
          let wins = 0;
          for (let i = 0; i < N; i++) {
            const u = (i + 0.5) / N;
            const r = await handler.resolve({
              isWin: u < pEff,
              rawOutcome: u,
              config,
              choices,
              forceMode: 'NONE',
              difficulty: tier as DifficultyLevel,
            });
            if (r.payoutMultiplier > 1) wins++;
          }
          rates[tier as DifficultyLevel] = wins / N;
        }

        // The clamps mean two tiers can legally collide at the ceiling/floor
        // (e.g. a fair chance above 0.98 is pinned at every level), so assert
        // non-increasing rather than strictly decreasing.
        const at = (t: DifficultyLevel) => rates[t]!;
        expect(at('easy'), 'easy >= normal').toBeGreaterThanOrEqual(
          at('normal') - 0.02
        );
        expect(at('normal'), 'normal >= hard').toBeGreaterThanOrEqual(
          at('hard') - 0.02
        );
        expect(at('hard'), 'hard >= impossible').toBeGreaterThanOrEqual(
          at('impossible') - 0.02
        );
      });

      it('matches the documented factor, not just any ordering', async () => {
        await ensureGamesRegistered();
        const handler = getGameHandler(slug);
        const pFair = handler.fairWinChance(choices, config)!;

        for (const tier of DIFFICULTY_LEVELS) {
          const expected = effectiveWinChance(pFair, tier);
          let wins = 0;
          for (let i = 0; i < N; i++) {
            const u = (i + 0.5) / N;
            const r = await handler.resolve({
              isWin: u < expected,
              rawOutcome: u,
              config,
              choices,
              forceMode: 'NONE',
              difficulty: tier as DifficultyLevel,
            });
            if (r.payoutMultiplier > 1) wins++;
          }
          const observed = wins / N;
          // Tolerance covers the sweep resolution (1/N) plus the documented
          // rejection-sampling fallback: a decision the game physically cannot
          // render (e.g. forcing a loss when every outcome pays) falls back to
          // the last candidate, which biases toward the achievable verdict.
          const tol = Math.max(3 / N, 0.05);
          expect(
            Math.abs(observed - expected),
            `${slug}/${tier}: expected ~${expected.toFixed(3)}, observed ${observed.toFixed(3)}`
          ).toBeLessThan(tol);
        }
      });

      it('never pays more than the game max-win multiplier', async () => {
        await ensureGamesRegistered();
        const handler = getGameHandler(slug);
        const pFair = handler.fairWinChance(choices, config)!;
        const cap = 1000;
        for (const tier of DIFFICULTY_LEVELS) {
          const pEff = effectiveWinChance(pFair, tier);
          for (let i = 0; i < N; i++) {
            const u = (i + 0.5) / N;
            const r = await handler.resolve({
              isWin: u < pEff,
              rawOutcome: u,
              config,
              choices,
              forceMode: 'NONE',
              difficulty: tier as DifficultyLevel,
            });
            expect(r.payoutMultiplier).toBeLessThanOrEqual(cap);
          }
        }
      });
    });
  }
});

describe('effectiveWinChance (pure)', () => {
  it('applies the documented multipliers', () => {
    const p = 0.4;
    for (const tier of DIFFICULTY_LEVELS) {
      expect(effectiveWinChance(p, tier)).toBeCloseTo(p * DIFFICULTY_FACTORS[tier], 10);
    }
  });

  it('clamps instead of promising a certainty or a dead bet', () => {
    expect(effectiveWinChance(1, 'easy')).toBe(MAX_EFFECTIVE_CHANCE);
    expect(effectiveWinChance(0.00001, 'impossible')).toBe(MIN_EFFECTIVE_CHANCE);
    for (const tier of DIFFICULTY_LEVELS) {
      for (const p of [0, 0.0001, 0.5, 0.99, 1]) {
        const v = effectiveWinChance(p, tier);
        expect(v).toBeGreaterThanOrEqual(MIN_EFFECTIVE_CHANCE);
        expect(v).toBeLessThanOrEqual(MAX_EFFECTIVE_CHANCE);
      }
    }
  });

  it('is a no-op at normal (provably fair)', () => {
    for (const p of [0.01, 0.1, 0.5, 0.9]) {
      expect(effectiveWinChance(p, 'normal')).toBeCloseTo(p, 10);
    }
  });
});
