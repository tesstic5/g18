// apps/api/src/engine/games/DragonTigerGame.ts — two cards, Dragon/Tiger/Tie (v3 GAME 12)
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { cardFromRaw } from './HiLoGame';
import { mulberry32 } from './MinesGame';

/** Exact chances from a full-deck two-card draw: 13 ranks x 4 suits.
 *  P(tie) = 3/51; a rank win splits the rest evenly. */
// M-03: the generator draws each side's rank INDEPENDENTLY with replacement
// (mulberry32 over 13 ranks), so P(tie) = Σ P(rank)² = 13·(1/13)² = 1/13.
// The old 3/51 was the WITHOUT-replacement deck probability — wrong for this
// generator, and difficulty/force conditioning was priced off it.
export const DRAGON_TIGER_CHANCES = {
  tie: 1 / 13,
  side: (1 - 1 / 13) / 2,
};

export class DragonTigerGame extends BaseGame {
  readonly slug = 'dragon-tiger';

  override fairWinChance(choices: Record<string, unknown>): number {
    const bet = (choices as { bet?: 'dragon' | 'tiger' | 'tie' }).bet ?? 'dragon';
    // A dragon/tiger bet PUSHES (stake back) on a tie, so the player's chance
    // of a profit is simply P(their side > other side).
    return bet === 'tie' ? DRAGON_TIGER_CHANCES.tie : DRAGON_TIGER_CHANCES.side;
  }

  resolve(params: ResolveParams): GameHandlerResult {
    return this.resolveDecided(params);
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
    choices,
  }: ResolveParams): GameHandlerResult {
    const rng = mulberry32(Math.floor(rawOutcome * 0xffffffff));
    const dragon = cardFromRaw(rng());
    const tiger = cardFromRaw(rng());
    const dv = rankValue(dragon.rank);
    const tv = rankValue(tiger.rank);
    const bet = (choices as { bet?: 'dragon' | 'tiger' | 'tie' }).bet ?? 'dragon';
    const outcome = dv > tv ? 'dragon' : tv > dv ? 'tiger' : 'tie';
    // Payouts are TOTAL RETURN (stake included). The tie default of 8× on a
    // 7.71%-probability event is only 61% RTP — by far the worst bet on the
    // platform and well below the 96% the game advertises. Measured over 200k
    // deals with this exact card logic: dragon 45.95% / tiger 46.35% / tie
    // 7.71%. Fair tie for a 96% target is 0.96 / 0.0771 = 12.46×.
    const payouts = (
      config.configJson as { payouts?: { dragon: number; tiger: number; tie: number } }
    ).payouts ?? { dragon: 1.95, tiger: 1.95, tie: 12.46 };
    // D-089: dragon/tiger bets PUSH (stake returned) on a tie.
    const isTiePush = outcome === 'tie' && bet !== 'tie';
    const won = bet === outcome || isTiePush;
    const multiplier = isTiePush ? 1 : won ? payouts[outcome] : 0;
    return {
      result: isTiePush ? 'PUSH' : won ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        dragon: dragon.rank + dragon.suit,
        tiger: tiger.rank + tiger.suit,
        outcome,
        bet,
        win: won,
        multiplier: won ? multiplier : 0,
      },
    };
  }
}

function rankValue(rank: string): number {
  return (
    {
      '2': 2,
      '3': 3,
      '4': 4,
      '5': 5,
      '6': 6,
      '7': 7,
      '8': 8,
      '9': 9,
      '10': 10,
      J: 11,
      Q: 12,
      K: 13,
      A: 14,
    }[rank] ?? 0
  );
}
