// CONTRACT TEST: every key a game handler READS must survive validation.
//
// The per-game zod schemas strip unknown keys. That is the right behaviour, but
// it means a schema that disagrees with its handler silently deletes the
// player's actual selection. Three shipped that way and all three broke the
// game in a way that looked like a "random" bug:
//
//   dice          `over` stripped   -> every bet resolved as UNDER (the opposite
//                                      of the tapped button) -> "it says I won
//                                      when I lost"
//   lucky-number  betMin/betMax     -> fell back to the full 1-100 range, so it
//                 stripped             won 100% of the time (measured)
//   scratch-card  `card` stripped   -> chosen card discarded
//
// This test pins the contract so it cannot happen again.
import { describe, it, expect } from 'vitest';
import { validateGameChoices } from '@casino/shared/validators/game-choices';

/** What the BOARD sends for each game (read off the components). */
const REAL_CHOICES: Record<string, Record<string, unknown>> = {
  dice: { over: true, target: 50.5 },
  limbo: { target: 2.5 },
  'coin-flip': { choice: 'heads' },
  wheel: { tier: '2x' },
  'ring-of-fortune': { tier: '2x' },
  'lucky-number': { betMin: 40, betMax: 60 },
  thimbles: { cup: 1 },
  plinko: { risk: 'medium', balls: 1 },
  keno: { picks: [1, 2, 3, 4, 5] },
  'scratch-card': { card: 0 },
  baccarat: { bet: 'player' },
  'dragon-tiger': { bet: 'dragon' },
  roulette: { bet: { type: 'red' } },
  mines: { mineCount: 3 },
  tower: { difficulty: 'medium' },
  stairs: { difficulty: 'medium' },
  'hi-lo': { guess: 'higher', currentRank: '7' },
  wingo: { choice: 'green', durationSec: 30 },
};

describe('every board selection survives validation', () => {
  for (const [slug, choices] of Object.entries(REAL_CHOICES)) {
    it(`${slug}: keeps every key the board sends`, () => {
      const res = validateGameChoices(slug, choices);
      expect(res.ok, `${slug} rejected: ${res.ok ? '' : res.message}`).toBe(true);
      if (!res.ok) return;
      for (const key of Object.keys(choices)) {
        expect(res.value, `${slug}.${key} was STRIPPED by the schema`).toHaveProperty(
          key
        );
      }
    });
  }
});

describe('the dice direction actually survives', () => {
  it('over:true is not silently turned into under', () => {
    const res = validateGameChoices('dice', { over: true, target: 90 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.over).toBe(true);
  });
  it('over:false is preserved too', () => {
    const res = validateGameChoices('dice', { over: false, target: 10 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.over).toBe(false);
  });
});

describe('lucky number zones are real zones', () => {
  it('keeps a narrow zone instead of defaulting to the whole range', () => {
    const res = validateGameChoices('lucky-number', { betMin: 50, betMax: 50 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toMatchObject({ betMin: 50, betMax: 50 });
  });
  it('rejects a backwards zone', () => {
    expect(validateGameChoices('lucky-number', { betMin: 80, betMax: 20 }).ok).toBe(
      false
    );
  });
});
