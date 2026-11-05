// apps/api/src/engine/win-rate.test.ts
//
// Regression for F001: settlement must never search later HMAC candidates to
// manufacture a target win rate. Player-priced choices can have natural odds
// from ~1% to 50%; forcing each to one game-wide rate while retaining its payout
// created four-figure RTP exploits and broke the public seed verifier.
import { describe, expect, it } from 'vitest';
import { GAME_SLUGS } from '@casino/shared/constants/games';
import { isSteerable } from './winRateSteering';

describe('outcome steering production gate', () => {
  it('fails closed for every registered game', () => {
    for (const slug of GAME_SLUGS) {
      expect(isSteerable(slug), slug).toBe(false);
    }
  });

  it('fails closed for future/unknown slugs too', () => {
    expect(isSteerable('future-player-priced-game')).toBe(false);
  });
});

describe('the verdict always matches the money', () => {
  it('classifies from the effective paid multiplier, not a nominal pre-cap value', () => {
    const reclassify = (multiplier: number, before: 'WIN' | 'LOSE') => {
      const paysMoreThanStake = multiplier > 1;
      if (!paysMoreThanStake && before === 'WIN') {
        return { result: 'LOSE', partialRefund: multiplier > 0 };
      }
      if (paysMoreThanStake && before === 'LOSE') {
        return { result: 'WIN', partialRefund: false };
      }
      return { result: before, partialRefund: false };
    };

    expect(reclassify(0.78, 'WIN')).toEqual({ result: 'LOSE', partialRefund: true });
    expect(reclassify(2.4, 'WIN').result).toBe('WIN');
    expect(reclassify(1, 'WIN').result).toBe('LOSE');
    expect(reclassify(0, 'LOSE')).toEqual({ result: 'LOSE', partialRefund: false });
  });
});
