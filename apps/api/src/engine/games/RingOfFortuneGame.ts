// apps/api/src/engine/games/RingOfFortuneGame.ts — prize-ring the player BETS on.
//
// Like the money wheel, this used to ignore `choices` completely: tap PLAY, the
// ring spins, you get whatever it lands on. No decision, no game.
//
// Now the ring has named prize tiers and the player backs one. It differs from
// the wheel by having a much longer tail — a genuine JACKPOT slice — so the two
// games feel different rather than being reskins of each other.
//
// Every tier pays 0.96 / P(tier), so all of them return ~96%.
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { buildRim, tierPayout, type WheelTier } from './WheelGame';
import { AppError } from '../../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import type { GameConfig } from '../../../src/generated/prisma/client';

/**
 * 36-slice ring with a deliberately long tail:
 *   bronze 18/36 = 50%     -> 1.92x
 *   silver  9/36 = 25%     -> 3.84x
 *   gold    6/36 = 16.67%  -> 5.76x
 *   ruby    2/36 = 5.56%   -> 17.28x
 *   jackpot 1/36 = 2.78%   -> 34.56x
 */
export function defaultRingTiers(): WheelTier[] {
  return [
    { id: 'bronze', label: 'BRONZE', color: '#c98b4b', slices: 18 },
    { id: 'silver', label: 'SILVER', color: '#c7d0dd', slices: 9 },
    { id: 'gold', label: 'GOLD', color: '#f5c842', slices: 6 },
    { id: 'ruby', label: 'RUBY', color: '#ff3b5c', slices: 2 },
    { id: 'jackpot', label: 'JACKPOT', color: '#9b59ff', slices: 1 },
  ];
}

export class RingOfFortuneGame extends BaseGame {
  readonly slug = 'ring-of-fortune';

  override fairWinChance(choices: Record<string, unknown>, config: GameConfig): number {
    const cfg = config.configJson as { tiers?: WheelTier[] };
    const tiers =
      Array.isArray(cfg.tiers) && cfg.tiers.length ? cfg.tiers : defaultRingTiers();
    const total = tiers.reduce((t, x) => t + x.slices, 0);
    const pickedId = String((choices as { tier?: string }).tier ?? '');
    const backed = tiers.find((t) => t.id === pickedId);
    return backed && total > 0 ? backed.slices / total : 0;
  }

  resolve(params: ResolveParams): GameHandlerResult {
    return this.resolveDecided(params);
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
    choices,
  }: ResolveParams): GameHandlerResult {
    const cfg = config.configJson as { tiers?: WheelTier[] };
    const tiers =
      Array.isArray(cfg.tiers) && cfg.tiers.length ? cfg.tiers : defaultRingTiers();
    const rim = buildRim(tiers);
    const total = rim.length;

    const index = Math.min(total - 1, Math.floor(rawOutcome * total));
    const pickedId = String((choices as { tier?: string }).tier ?? '');
    const backed = tiers.find((t) => t.id === pickedId) ?? null;

    const landedId = rim[index]!;
    const landedTier = tiers.find((t) => t.id === landedId) ?? tiers[0]!;

    // M-02: unknown tier → reject with rollback, never a silent loss (same
    // fix as WheelGame — there is no noPick refund path in the engine).
    if (!backed) {
      throw new AppError(
        ERROR_CODES.GAME_INVALID_CHOICES,
        422,
        `Unknown ring tier: ${pickedId}`
      );
    }

    const won = landedId === backed.id;
    const payout = tierPayout(backed, total);
    const multiplier = won ? payout : 0;

    return {
      result: won ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        rim,
        index,
        landedId,
        landedLabel: landedTier.label,
        landedColor: landedTier.color,
        tiers,
        tier: backed.id,
        tierLabel: backed.label,
        win: won,
        multiplier,
        payoutIfWin: payout,
        isJackpot: landedId === 'jackpot',
      },
    };
  }
}
