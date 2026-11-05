// apps/api/src/engine/games/DiceGame.ts — dice game handler (docs/21 GAME 5 + docs/13 DICE)
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { AppError } from '../../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';

interface DiceChoices {
  over: boolean;
  target: number;
} // target (0, 100) exclusive

/** M-02 second line: reject — never coerce — a choice the route would drop. */
function assertDiceChoices(choices: Record<string, unknown>): DiceChoices {
  const c = choices as unknown as DiceChoices & { direction?: string };
  if (typeof c.over !== 'boolean' || c.direction !== undefined)
    throw new AppError(
      ERROR_CODES.GAME_INVALID_CHOICES,
      422,
      'Dice bet must include an explicit over: boolean'
    );
  if (typeof c.target !== 'number' || !(c.target > 0) || !(c.target < 100))
    throw new AppError(
      ERROR_CODES.GAME_INVALID_CHOICES,
      422,
      'Dice target must be in (0, 100)'
    );
  return c;
}

export class DiceGame extends BaseGame {
  readonly slug = 'dice';

  // FAIR WIN CHANCE — the engine's difficulty knob scales exactly this.
  override fairWinChance(choices: Record<string, unknown>): number {
    const { over, target } = assertDiceChoices(choices);
    return over ? (100 - target) / 100 : target / 100;
  }

  resolve(params: ResolveParams): GameHandlerResult {
    return this.resolveDecided(params);
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
    choices,
  }: ResolveParams): GameHandlerResult {
    const { over, target } = assertDiceChoices(choices);
    const probability = over ? (100 - target) / 100 : target / 100;
    // H-4: a silent half-price trap. `clamp` quietly caps the payout at
    // maxWinMultiplier, so an "over 98" bet that mathematically pays 49.5x was
    // settled at the 25x cap — a 49.3% RTP round with nothing on screen saying
    // so. The fair price is still computed and reported alongside the capped
    // one, so the UI can warn BEFORE the player commits.
    const fairMultiplier = 99 / (probability * 100);
    const payoutMultiplier = this.clamp(fairMultiplier, config);
    const capped = fairMultiplier > payoutMultiplier + 1e-9;

    // D-089: the ROLL is the truth — win = roll vs target, NOT the global
    // winRate. (Previously win came from winRate: picking target 90 paid 9.9×
    // while winning 49% of the time → 485% RTP exploit. Now a 90-target wins
    // ~10% and pays 9.9× → ~99% RTP as designed.)
    // Difficulty/force rounds sample this same mapping conditioned on the
    // decided verdict, so the shown roll ALWAYS justifies the settled result.
    const roll = rawOutcome * 100;
    const won = over ? roll > target : roll < target;

    return {
      result: won ? 'WIN' : 'LOSE',
      payoutMultiplier: won ? payoutMultiplier : 0,
      mappedOutcome: {
        resultNumber: Math.floor(rawOutcome * 10000) / 100, // 0.00–100.00 (server-truth)
        over,
        target,
        winChance: probability * 100,
        multiplier: payoutMultiplier,
        // H-4: surfaced so the board can say "capped at 25x" instead of
        // silently paying half the advertised price.
        fairMultiplier: +fairMultiplier.toFixed(4),
        capped,
      },
    };
  }
}
