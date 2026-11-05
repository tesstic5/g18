// apps/api/src/engine/games/ThimblesGame.ts — 3 cups, pick correct (v3 GAME 15 + v8)
import { AppError } from '../../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import type { GameConfig } from '../../../src/generated/prisma/client';

export class ThimblesGame extends BaseGame {
  readonly slug = 'thimbles';

  override fairWinChance(
    _choices: Record<string, unknown>,
    config: GameConfig
  ): number {
    const cups = Number((config.configJson as { cups?: number }).cups ?? 3);
    return 1 / Math.max(2, cups);
  }

  resolve(params: ResolveParams): GameHandlerResult {
    return this.resolveDecided(params);
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
    choices,
  }: ResolveParams): GameHandlerResult {
    const cups = Number((config.configJson as { cups?: number }).cups ?? 3);
    const ballCup = Math.min(cups - 1, Math.floor(rawOutcome * cups));
    const rawCup = (choices as { cup?: unknown }).cup;
    // M-02: the cup count is live-config — REJECT a pick the config can't hold
    // instead of silently clamping/defaulting it onto cup 0 (a bet the player
    // never made). The route schema only pins the absolute 0..16 bound.
    if (
      !Number.isInteger(rawCup) ||
      (rawCup as number) < 0 ||
      (rawCup as number) >= cups
    )
      throw new AppError(
        ERROR_CODES.GAME_INVALID_CHOICES,
        422,
        `Cup must be an integer 0..${cups - 1} for this table`
      );
    const pick = rawCup as number;
    // D-089: the cup is the truth — win/lose from the ball position only,
    // NOT the global winRate. Force/difficulty rounds are produced by
    // resolveDecided sampling this mapping conditioned on the verdict, so
    // a forced WIN shows the ball under the player's cup — never a banner
    // that contradicts the animation.
    const won = pick === ballCup;
    const payout = Number(
      (config.configJson as { payout_multiplier?: number }).payout_multiplier ?? 2.88
    );
    return {
      result: won ? 'WIN' : 'LOSE',
      payoutMultiplier: won ? Math.min(payout, Number(config.maxWinMultiplier)) : 0,
      mappedOutcome: { ballCup, pick, win: won, multiplier: won ? payout : 0 },
    };
  }
}
