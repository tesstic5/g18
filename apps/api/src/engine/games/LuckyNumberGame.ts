// apps/api/src/engine/games/LuckyNumberGame.ts — range bet, delta ladder (v3 GAME 20 + v8)
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { luckyExactPayout } from '@casino/shared/constants/lucky-number';
import type { GameConfig } from '../../../src/generated/prisma/client';

export class LuckyNumberGame extends BaseGame {
  readonly slug = 'lucky-number';

  /** P(any ladder tier that pays > 1x) for this zone, counted exactly over the
   *  result range (edge zones clip the delta ladder — no approximation). */
  override fairWinChance(choices: Record<string, unknown>, config: GameConfig): number {
    const cfg = config.configJson as {
      min?: number;
      max?: number;
      payout_ladder?: Array<{ max_delta: number; multiplier: number }>;
    };
    const min = cfg.min ?? 1,
      max = cfg.max ?? 100;
    const span = max - min + 1;
    const betMin = Number((choices as { betMin?: number }).betMin ?? min);
    const betMax = Number((choices as { betMax?: number }).betMax ?? max);
    const zoneSize = Math.max(1, Math.min(span, betMax - betMin + 1));
    // Single source of truth (shared with the bet validator): the floor is
    // what makes an over-wide zone pay more than it should, so the guard and
    // the payout must be computed from the same formula.
    const exactPayout = luckyExactPayout(span, zoneSize);
    const ladder = cfg.payout_ladder ?? [
      { max_delta: 0, multiplier: exactPayout },
      { max_delta: 2, multiplier: 0.2 },
      { max_delta: 5, multiplier: 0.1 },
      { max_delta: 10, multiplier: 0.05 },
    ];
    const payAt = (delta: number) =>
      ladder.find((l) => delta <= l.max_delta)?.multiplier ?? 0;
    // zones wider than ~half the span are common enough to count directly
    let hits = 0;
    for (let r = min; r <= max; r++) {
      const delta =
        r >= betMin && r <= betMax
          ? 0
          : Math.min(Math.abs(r - betMin), Math.abs(r - betMax));
      if (payAt(delta) > 1) hits++;
      if (span > 100000) break; // absurd config — keep the loop bounded
    }
    return hits / span;
  }

  resolve(params: ResolveParams): GameHandlerResult {
    return this.resolveDecided(params);
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
    choices,
  }: ResolveParams): GameHandlerResult {
    const cfg = config.configJson as {
      min?: number;
      max?: number;
      payout_ladder?: Array<{ max_delta: number; multiplier: number }>;
    };
    const min = cfg.min ?? 1,
      max = cfg.max ?? 100;
    const result = min + Math.floor(rawOutcome * (max - min + 1));
    const betMin = Number((choices as { betMin?: number }).betMin ?? min);
    const betMax = Number((choices as { betMax?: number }).betMax ?? max);

    const delta =
      result >= betMin && result <= betMax
        ? 0
        : Math.min(Math.abs(result - betMin), Math.abs(result - betMax));
    const span = max - min + 1; // outcomes in the whole range (100 by default)

    // FAIR width-based payouts. The result is uniform over [min, max], so the
    // chosen zone [betMin, betMax] covers `zoneSize` of them.
    //
    // BUG FIXED: this used `width = Math.max(1, betMax - betMin)` and then
    // `width + 1` as the zone size. For a SINGLE-number bet (betMin === betMax)
    // the true zone size is 1, but the clamp forced width to 1 → zone size 2 →
    // the payout was HALVED (48× instead of ~94×). Measured RTP on a single
    // number was 49% while every other bet paid ~96%. The clamp is gone; the
    // zone size is now simply the count of covered numbers.
    const zoneSize = Math.max(1, Math.min(span, betMax - betMin + 1));

    // The near-miss consolation windows also pay out, so they must be counted
    // in the house edge or the game leaks RTP. Expected consolation per round:
    //   delta 1-2  → 4 outcomes × 0.2  = 0.8
    //   delta 3-5  → 6 outcomes × 0.1  = 0.6
    //   delta 6-10 → 10 outcomes × 0.05 = 0.5
    // = 1.9 / span of expected return. The exact-hit payout takes what's left
    // of the 96% target, so total RTP lands on ~96% for ANY zone width.
    // Single source of truth (shared with the bet validator): the floor is
    // what makes an over-wide zone pay more than it should, so the guard and
    // the payout must be computed from the same formula.
    const exactPayout = luckyExactPayout(span, zoneSize);
    const ladder = cfg.payout_ladder ?? [
      { max_delta: 0, multiplier: exactPayout },
      { max_delta: 2, multiplier: 0.2 },
      { max_delta: 5, multiplier: 0.1 },
      { max_delta: 10, multiplier: 0.05 },
    ];
    const multiplier = ladder.find((l) => delta <= l.max_delta)?.multiplier ?? 0;
    // WIN = paid back more than the stake. A near-miss pays a small consolation
    // (0.2× / 0.1× / 0.05×), which is still a net loss — it must NOT be a WIN.
    // Conversely the old code reported `multiplier: 0` in mappedOutcome for
    // every near-miss even though the wallet WAS credited 0.2×, so the UI told
    // the player "you got nothing" while the balance quietly moved.
    const won = multiplier >= 1;
    const exactHit = delta === 0;
    const partialRefund = multiplier > 0 && multiplier < 1;
    return {
      result: won ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        result,
        betMin,
        betMax,
        delta,
        win: won,
        exactHit,
        partialRefund,
        multiplier,
      },
    };
  }
}
