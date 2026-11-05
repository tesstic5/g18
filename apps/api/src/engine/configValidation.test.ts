// C-06: per-game strict config validation + per-choice RTP bounds.
import { describe, it, expect } from 'vitest';
import { validateConfig } from '@casino/shared';
import {
  validateGameConfigJson,
  STRICTLY_VALIDATED_GAMES,
  patchTouchesOdds,
  usesGenericPayoutWeights,
} from './configValidation';
import { LIMITS } from '@casino/shared/constants/limits';

const M = 10_000; // generous maxWinMultiplier for the generic tests

describe('C-06 — per-game strict config validation', () => {
  it('covers every strict game the seed ships', () => {
    // If a game gets its own configJson keys, it needs a schema here; tests
    // elsewhere exercise the registry end-to-end.
    expect(STRICTLY_VALIDATED_GAMES.length).toBeGreaterThanOrEqual(15);
  });

  it('rejects unknown keys (typos must not silently no-op)', () => {
    const r = validateGameConfigJson(
      'coinflip',
      { options: ['heads', 'tails'], payout: 1.92, win_probability: 0.5, payot: 5 },
      M
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.field === 'payot')).toBe(true);
  });

  it('accepts the stock coinflip config', () => {
    const r = validateGameConfigJson(
      'coinflip',
      { options: ['heads', 'tails'], payout: 1.92, win_probability: 0.5 },
      M
    );
    expect(r.ok).toBe(true);
    expect(r.worstCaseRtp).toBeCloseTo(96, 5);
  });

  it('rejects a coinflip with RTP over the ceiling', () => {
    const r = validateGameConfigJson(
      'coinflip',
      { options: ['heads', 'tails'], payout: 2.5, win_probability: 0.5 },
      M
    );
    expect(r.ok).toBe(false); // 125% RTP
  });

  it('rejects a coinflip whose payout exceeds maxWinMultiplier', () => {
    const r = validateGameConfigJson(
      'coinflip',
      { options: ['heads', 'tails'], payout: 1.92, win_probability: 0.5 },
      1.5
    );
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain('maxWinMultiplier');
  });

  it('rejects an empty/impossible crash distribution', () => {
    expect(validateGameConfigJson('aviator', { crash_distribution: {} }, M).ok).toBe(
      false
    );
    expect(
      validateGameConfigJson('aviator', { crash_distribution: { '1-2': 0 } }, M).ok
    ).toBe(false);
    expect(
      validateGameConfigJson('aviator', { crash_distribution: { '5-2': 10 } }, M).ok
    ).toBe(false); // upper < lower
  });

  it('accepts the stock crash distribution incl. "+" tail', () => {
    const r = validateGameConfigJson(
      'aviator',
      {
        crash_distribution: {
          '1.00-1.10': 12.7,
          '1.10-1.50': 23.3,
          '10.00-25.00': 5.8,
          '25.00-100.00': 2.9,
          '100.00+': 1.0,
        },
        round_interval_ms: 5000,
      },
      M
    );
    expect(r.ok).toBe(true); // C-04-capped tail: max +100 → 400× ≤ 10,000×
  });

  it('rejects a "+" tail that outruns maxWinMultiplier', () => {
    const r = validateGameConfigJson(
      'aviator',
      { crash_distribution: { '1-2': 90, '10000+': 10 } },
      1000
    );
    expect(r.ok).toBe(false); // tail pays up to 30,000× > 1000×
  });

  it('keno: exact hypergeometric RTP is enforced per pick table', () => {
    // fair price for 10-P pick-1 pays ~2.56; paying 5× doubles that.
    const greedy = validateGameConfigJson(
      'keno',
      {
        grid_size: 40,
        max_picks: 10,
        draw_count: 20,
        payout_tables: { '1_picks': { '0': 0, '1': 5 } },
      },
      M
    );
    expect(greedy.ok).toBe(false); // P(hit)=20/40=0.5 → RTP 250%

    const sane = validateGameConfigJson(
      'keno',
      {
        grid_size: 40,
        max_picks: 10,
        draw_count: 20,
        payout_tables: { '1_picks': { '0': 0, '1': 1.9 } },
      },
      M
    );
    expect(sane.ok).toBe(true); // 0.5×1.9 = 95%
  });

  it('keno: impossible tables (picks > grid) never validate', () => {
    const r = validateGameConfigJson(
      'keno',
      {
        grid_size: 40,
        max_picks: 3,
        draw_count: 20,
        payout_tables: { '9_picks': { '9': 10 } },
      },
      M
    );
    expect(r.ok).toBe(false);
  });

  it('plinko: exact binomial RTP per rows table', () => {
    const overPays = validateGameConfigJson(
      'plinko',
      {
        default_rows: 2,
        risk_levels: {
          low: { '2': [5, 5, 5] }, // every bucket 5× → RTP 500%
        },
      },
      M
    );
    expect(overPays.ok).toBe(false);

    const sane = validateGameConfigJson(
      'plinko',
      {
        default_rows: 2,
        default_risk: 'low',
        risk_levels: { low: { '2': [1.5, 0.44, 1.5] } },
      },
      M
    );
    // E = 0.25×1.5 + 0.5×0.44 + 0.25×1.5 = 0.97 → 97%
    expect(sane.ok).toBe(true);
  });

  it('plinko: wrong bucket count (rows+1) is caught', () => {
    const r = validateGameConfigJson(
      'plinko',
      { risk_levels: { low: { '8': [1, 1, 1] } } }, // 8 rows needs 9 buckets
      M
    );
    expect(r.ok).toBe(false);
  });

  it('roulette: every listed bet type must be winnable and under the cap', () => {
    const sane = validateGameConfigJson(
      'roulette',
      {
        pockets: 37,
        payouts: { straight: 36, dozen: 3, red: 2 }, // straight: 1/37×36 = 97.3% ✓
      },
      M
    );
    expect(sane.ok).toBe(true);

    const impossible = validateGameConfigJson(
      'roulette',
      { pockets: 37, payouts: { inside_quint: 7 } },
      M
    );
    expect(impossible.ok).toBe(false); // unknown bet type

    const explosion = validateGameConfigJson(
      'roulette',
      { pockets: 37, payouts: { straight: 40 } }, // 1/37×40 = 108% RTP
      M
    );
    expect(explosion.ok).toBe(false);
  });

  it('wheel tiers: derived fair payouts, no guaranteed-loss tiers', () => {
    const guaranteedLoss = validateGameConfigJson(
      'wheel',
      {
        tiers: [
          { id: 'a', label: 'A', slices: 100 },
          { id: 'b', label: 'B', slices: 1 }, // payout 0.96×101/1 = 96.96×
        ],
      },
      M
    );
    // 'a' pays 0.96/(100/101) = 0.9696× < 1 — guaranteed loss
    expect(guaranteedLoss.ok).toBe(false);

    const sane = validateGameConfigJson(
      'wheel',
      {
        tiers: [
          { id: 'a', label: 'A', slices: 24 },
          { id: 'b', label: 'B', slices: 12 },
        ],
      },
      M
    );
    expect(sane.ok).toBe(true);
  });

  it('wingo: RTP of every bet type checked against its true probability', () => {
    const sane = validateGameConfigJson(
      'wingo',
      {
        round_duration_sec: 30,
        round_durations: [30, 60, 180, 300],
        bet_lock_sec: 5,
        number_weights: Array.from({ length: 10 }, (_, number) => ({
          number,
          weight: 10,
        })),
        payouts: {
          red: 1.96,
          green: 1.96,
          violet: 1.96,
          number: 1.96,
          big: 1.96,
          small: 1.96,
        },
      },
      M
    );
    expect(sane.ok).toBe(true);

    const rigged = validateGameConfigJson(
      'wingo',
      {
        round_durations: [30],
        payouts: {
          red: 3.0,
          green: 2.4,
          violet: 4.8,
          number: 9.6,
          big: 1.92,
          small: 1.92,
        },
        number_weights: Array.from({ length: 10 }, (_, number) => ({
          number,
          weight: 10,
        })),
      },
      M
    );
    expect(rigged.ok).toBe(false); // 3.0 × 40% = 120%
  });

  it('stairs: a ladder shorter than the board is rejected; guaranteed-loss rungs are rejected', () => {
    expect(
      validateGameConfigJson(
        'stairs',
        { steps: 10, choices_per_step: 2, safe_per_step: 1, payout_ladder: [1.1, 1.2] },
        M
      ).ok
    ).toBe(false); // only 2 rungs for 10 steps

    const r = validateGameConfigJson(
      'stairs',
      {
        steps: 2,
        choices_per_step: 2,
        safe_per_step: 1,
        payout_ladder: [0.9, 1.5], // 0.9× rung = guaranteed loss even on success
      },
      M
    );
    expect(r.ok).toBe(false);
  });

  it('tower: a difficulty with traps ≥ columns (guaranteed loss) is refused', () => {
    const r = validateGameConfigJson(
      'tower',
      // engine keys (columns_per_floor/traps_per_floor — gameSessions.ts)
      {
        floors: 10,
        difficulties: { easy: { columns_per_floor: 3, traps_per_floor: 3 } },
      },
      M
    );
    expect(r.ok).toBe(false);
  });

  it('tower: seeded shape passes (floors + per-difficulty columns/traps)', () => {
    const r = validateGameConfigJson(
      'tower',
      {
        floors: 10,
        difficulties: {
          easy: { columns_per_floor: 3, traps_per_floor: 1 },
          medium: { columns_per_floor: 4, traps_per_floor: 2 },
          hard: { columns_per_floor: 4, traps_per_floor: 3 },
          expert: { columns_per_floor: 5, traps_per_floor: 4 },
        },
      },
      10_000_000 // no ladders → fair expert full-climb = 0.96/(1/5)^10 = 9.375M×
    );
    expect(r.issues).toEqual([]);
  });

  it('tower: admin per-floor ladder is the liability, not the fair exponential', () => {
    const r = validateGameConfigJson(
      'tower',
      {
        floors: 10,
        difficulties: {
          easy: {
            columns_per_floor: 3,
            traps_per_floor: 1,
            payout_ladder: [1.4, 1.75, 2.2, 2.75, 3.45, 4.3, 5.4, 6.75, 8.4, 10.5],
          },
          medium: {
            columns_per_floor: 4,
            traps_per_floor: 2,
            payout_ladder: [1.85, 2.6, 3.65, 5.1, 7.1, 10, 14, 19.5, 27, 38],
          },
          hard: {
            columns_per_floor: 4,
            traps_per_floor: 3,
            payout_ladder: [3.5, 5.5, 8.6, 13.5, 21, 33, 52, 82, 130, 200],
          },
          expert: {
            columns_per_floor: 5,
            traps_per_floor: 4,
            payout_ladder: [4.4, 7.5, 13, 22, 38, 65, 110, 185, 310, 520],
          },
        },
      },
      1000
    );
    expect(r.issues).toEqual([]);
    expect(r.maxPayout).toBe(520);
  });

  it('tower: a first-floor overpay (RTP > 99%) is refused', () => {
    // easy: 2/3 survive × 3× = 200% RTP
    const r = validateGameConfigJson(
      'tower',
      {
        floors: 10,
        difficulties: {
          easy: {
            columns_per_floor: 3,
            traps_per_floor: 1,
            payout_ladder: [3, 3.2, 3.4, 3.6, 3.8, 4, 4.2, 4.4, 4.6, 4.8],
          },
        },
      },
      1000
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('RTP'))).toBe(true);
  });

  it('tower: a short admin ladder is refused', () => {
    const r = validateGameConfigJson(
      'tower',
      {
        floors: 10,
        difficulties: {
          easy: {
            columns_per_floor: 3,
            traps_per_floor: 1,
            payout_ladder: [1.4, 1.75],
          },
        },
      },
      1000
    );
    expect(r.ok).toBe(false);
  });

  it('thimbles: win_probability must agree with cups', () => {
    const lying = validateGameConfigJson(
      'thimbles',
      { cups: 3, win_probability: 0.5, payout_multiplier: 2.88 },
      M
    );
    expect(lying.ok).toBe(false); // 3 cups → true p = 0.333
    const sane = validateGameConfigJson(
      'thimbles',
      { cups: 3, win_probability: 0.338, payout_multiplier: 2.88 },
      M
    );
    expect(sane.ok).toBe(true); // 0.338×2.88 = 97.3%
  });

  it('lucky-number: delta-band RTP is computed exactly', () => {
    const r = validateGameConfigJson(
      'lucky-number',
      { min: 1, max: 100, payout_ladder: [{ max_delta: 10, multiplier: 50 }] },
      M
    );
    // width 21/100 × 50 = 1050% RTP
    expect(r.ok).toBe(false);
  });

  it('scratch-card: Monte-Carlo RTP bound (seeded, deterministic)', () => {
    const sane = validateGameConfigJson(
      'scratch-card',
      {
        grid: { rows: 3, cols: 3 },
        symbols: [
          { symbol: '💰', weight: 30 },
          { symbol: '💎', weight: 25 },
          { symbol: '🎰', weight: 20 },
          { symbol: '🎲', weight: 15 },
          { symbol: '⭐', weight: 7 },
          { symbol: '🍀', weight: 3 },
        ],
        win_combos: [
          { symbol: '💰', count: 5, multiplier: 5 }, // P(≥5 of 9 @ p=.30) ≈ 9.9% → ≈0.5×
          { symbol: '💎', count: 5, multiplier: 6 }, // P(≥5 of 9 @ p=.25) ≈ 4.9% → ≈0.3×
        ],
      },
      M
    );
    expect(sane.ok).toBe(true);

    const explosion = validateGameConfigJson(
      'scratch-card',
      {
        grid: { rows: 3, cols: 3 },
        symbols: [
          { symbol: '💰', weight: 90 },
          { symbol: '💎', weight: 10 },
        ],
        win_combos: [{ symbol: '💰', count: 3, multiplier: 10 }],
      },
      M
    );
    expect(explosion.ok).toBe(false); // nearly every card wins 10×
  });

  it('baccarat + dragon-tiger: exact card-game RTP bounds', () => {
    const saneB = validateGameConfigJson(
      'baccarat',
      { decks: 8, payouts: { player: 1.95, banker: 1.9, tie: 10.13 } },
      M
    );
    expect(saneB.ok).toBe(true); // ~87%–90% per bet ≈ standard
    const badB = validateGameConfigJson(
      'baccarat',
      { decks: 8, payouts: { player: 2.3, banker: 1.9, tie: 10.13 } },
      M
    );
    expect(badB.ok).toBe(false); // 44.6% × 2.3 = 102.6%

    const saneD = validateGameConfigJson(
      'dragon-tiger',
      { deck_size: 52, payouts: { dragon: 1.95, tiger: 1.95, tie: 12.46 } },
      M
    );
    expect(saneD.ok).toBe(true); // p(side)=6/13 ≈ 46.15% × 1.95 = 90%

    const badD = validateGameConfigJson(
      'dragon-tiger',
      { deck_size: 52, payouts: { dragon: 2.2, tiger: 1.95, tie: 12.46 } },
      M
    );
    expect(badD.ok).toBe(false); // 6/13 × 2.2 = 101.5%
  });

  it('RTP_CEILING is the single source of truth for these bounds', () => {
    expect(LIMITS.RTP_CEILING).toBeGreaterThanOrEqual(95);
    expect(LIMITS.RTP_CEILING).toBeLessThanOrEqual(100);
  });
});

describe('admin patches — hide must not require valid leftover odds', () => {
  it('treats isActive / tags / Hot as operational (no odds validation)', () => {
    expect(patchTouchesOdds({ isActive: false })).toBe(false);
    expect(patchTouchesOdds({ isActive: true, tags: ['hot'] })).toBe(false);
    expect(patchTouchesOdds({ displayName: 'Aviator' })).toBe(false);
    expect(patchTouchesOdds({ winRate: 48 })).toBe(true);
    expect(patchTouchesOdds({ configJson: {} })).toBe(true);
    expect(patchTouchesOdds({ isActive: false, maxWinMultiplier: 12 })).toBe(true);
  });

  it('aviator leftover payout_weights blow the generic RTP ceiling', () => {
    const r = validateConfig({
      winRate: 48,
      maxWinMultiplier: 100,
      payoutWeights: [
        { multiplier: 1.5, weight: 30 },
        { multiplier: 2.0, weight: 25 },
        { multiplier: 3.0, weight: 20 },
        { multiplier: 5.0, weight: 12 },
        { multiplier: 10.0, weight: 8 },
        { multiplier: 25.0, weight: 4 },
        { multiplier: 50.0, weight: 1 },
      ],
    });
    expect(r.valid).toBe(false);
    expect(r.calculatedRtp).toBeGreaterThan(99);
    expect(usesGenericPayoutWeights('aviator')).toBe(false);
    expect(usesGenericPayoutWeights('crash-x')).toBe(false);
    expect(usesGenericPayoutWeights('plinko')).toBe(true);
  });
});
