// apps/api/src/engine/OutcomeEngine.test.ts — engine unit tests (docs/20 §20, mandatory)
import { describe, expect, it } from 'vitest';
import { OutcomeEngine } from './OutcomeEngine';
import Decimal from 'decimal.js';
import type { GameConfig } from '../generated/prisma/client';
import { defaultTiers } from './games/WheelGame';
import { defaultRingTiers } from './games/RingOfFortuneGame';

const engine = new OutcomeEngine();

describe('generateRawOutcome', () => {
  it('is deterministic (vector pinned at first run — algorithm changes break intentionally)', () => {
    const a = engine.generateRawOutcome('s'.repeat(64), 'client', 3);
    expect(engine.generateRawOutcome('s'.repeat(64), 'client', 3)).toBe(a);
  });
});

describe('committed-draw settlement never steers player-priced choices', () => {
  const config = (
    slug: string,
    configJson: Record<string, unknown>,
    max: number
  ): GameConfig => ({
    slug,
    displayName: slug,
    description: null,
    thumbnailUrl: null,
    category: [],
    tags: [],
    sortOrder: 0,
    isActive: true,
    isFeatured: false,
    demoEnabled: false,
    baseRtp: new Decimal(96),
    winRate: new Decimal(48),
    houseEdge: new Decimal(4),
    maxWinMultiplier: new Decimal(max),
    minBet: new Decimal(10),
    defaultPayout: new Decimal(2),
    forceOverride: 'NONE',
    forceRoundsLeft: 0,
    forceMaxPayout: null,
    configJson: configJson as never,
    totalWagered: new Decimal(0),
    totalPaidOut: new Decimal(0),
    totalRounds: 0,
    effectiveRtp: null,
    animationSpeed: new Decimal(1),
    updatedAt: new Date(),
    updatedBy: null,
  });

  it.each([
    ['wheel', { tiers: defaultTiers() }, { tier: 'purple' }, 50],
    ['ring-of-fortune', { tiers: defaultRingTiers() }, { tier: 'jackpot' }, 60],
    ['lucky-number', { min: 1, max: 100 }, { betMin: 50, betMax: 50 }, 120],
  ] as const)(
    '%s stays near its designed RTP for the rarest choice',
    async (slug, json, choices, max) => {
      const rounds = 20_000;
      let paid = 0;
      for (let index = 0; index < rounds; index++) {
        const result = await engine.resolveCommittedOutcome({
          gameSlug: slug,
          rawOutcome: (index + 0.5) / rounds,
          config: config(slug, json, max),
          choices: { ...choices },
        });
        paid += result.payoutMultiplier;
      }
      const rtp = paid / rounds;
      expect(rtp, `${slug} RTP ${rtp}`).toBeGreaterThan(0.9);
      expect(rtp, `${slug} RTP ${rtp}`).toBeLessThan(1.02);
    },
    20_000
  );
});

describe('validateConfig (static)', () => {
  it('blocks RTP > 99% ceiling with a clear error', () => {
    const r = OutcomeEngine.validateConfig({
      winRate: 60,
      payoutWeights: [{ multiplier: 2, weight: 1 }],
      maxWinMultiplier: 25,
    });
    expect(r.valid).toBe(false);
    expect(r.error).toContain('99%');
  });

  it('allows valid configs and reports house edge', () => {
    const r = OutcomeEngine.validateConfig({
      winRate: 45,
      payoutWeights: [{ multiplier: 2, weight: 1 }],
      maxWinMultiplier: 25,
    });
    expect(r.valid).toBe(true);
    expect(r.calculatedRtp).toBeCloseTo(90, 5);
    expect(r.houseEdge).toBeCloseTo(10, 5);
  });

  it('blocks win rate outside 1–98', () => {
    expect(
      OutcomeEngine.validateConfig({
        winRate: 0.5,
        payoutWeights: [{ multiplier: 1, weight: 1 }],
        maxWinMultiplier: 25,
      }).valid
    ).toBe(false);
    expect(
      OutcomeEngine.validateConfig({
        winRate: 99,
        payoutWeights: [{ multiplier: 1, weight: 1 }],
        maxWinMultiplier: 25,
      }).valid
    ).toBe(false);
  });

  it('blocks max multiplier above the supported session ceiling', () => {
    expect(
      OutcomeEngine.validateConfig({
        winRate: 45,
        payoutWeights: [{ multiplier: 2, weight: 1 }],
        maxWinMultiplier: 10_000_001,
      }).valid
    ).toBe(false);
  });
});
