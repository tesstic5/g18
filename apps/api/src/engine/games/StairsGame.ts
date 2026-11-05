// apps/api/src/engine/games/StairsGame.ts — Tower variant, 2 choices per step (v3 GAME 18 + v8)
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { mulberry32 } from './MinesGame';

export class StairsGame extends BaseGame {
  readonly slug = 'stairs';

  resolve({
    rawOutcome,
    config,
    choices,
    forceMode,
  }: ResolveParams): GameHandlerResult {
    const cfg = config.configJson as {
      steps?: number;
      choices_per_step?: number;
      safe_per_step?: number;
      payout_ladder?: number[];
    };
    const step = Number((choices as { step?: number }).step ?? 0);
    const pick = Number((choices as { pick?: number }).pick ?? 0);
    const safeStep =
      mulberry32(Math.floor(rawOutcome * 0xffffffff) + step)() <
      (cfg.safe_per_step ?? 1) / (cfg.choices_per_step ?? 2);
    // D-089: the random step is the truth — NOT the global winRate.
    const safe =
      forceMode === 'FORCE_WIN' ? true : forceMode === 'FORCE_LOSE' ? false : safeStep;
    const ladder = cfg.payout_ladder ?? [
      1.92, 3.84, 7.68, 15.36, 30.72, 61.44, 100, 100, 100, 100,
    ];
    const multiplier = safe ? (ladder[Math.min(step, ladder.length - 1)] ?? 0) : 0;
    return {
      result: safe ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        step,
        pick,
        safe,
        currentMultiplier: safe ? multiplier : 0,
        choices: cfg.choices_per_step ?? 2,
      },
    };
  }
}
