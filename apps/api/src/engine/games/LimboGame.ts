// apps/api/src/engine/games/LimboGame.ts — target multiplier, exponential curve (v3 GAME 10 + v8)
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';

export function limboResult(raw: number): number {
  // exponential distribution: 1/(1-raw) clamped to [1, 1e6]
  return Math.min(1000000, Math.max(1.0, 1 / (1 - raw)));
}

export class LimboGame extends BaseGame {
  readonly slug = 'limbo';

  override fairWinChance(choices: Record<string, unknown>): number {
    const t = this.target(choices);
    return 1 / t;
  }

  resolve(params: ResolveParams): GameHandlerResult {
    return this.resolveDecided(params);
  }

  private target(choices: Record<string, unknown>): number {
    const rawTarget = Number((choices as { target?: number }).target ?? 2);
    return Number.isFinite(rawTarget) ? Math.max(1.01, rawTarget) : 2;
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
    choices,
  }: ResolveParams): GameHandlerResult {
    // H-5: a negative or sub-1 target produced a NEGATIVE multiplier and wrote
    // negative payout rows, which corrupts every RTP report that sums them
    // (target -5 measured -495% RTP). The route schema rejects it now; this is
    // the handler's own guard. 1.01x is the lowest meaningful Limbo target.
    const target = this.target(choices);
    const result = limboResult(rawOutcome);
    const won = result >= target;
    const factor = Number(
      (config.configJson as { rtp_adjustment_factor?: number }).rtp_adjustment_factor ??
        0.99
    );
    const multiplier = won ? target * factor : 0;
    return {
      result: won ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        result: +result.toFixed(2),
        target,
        win: won,
        winChance: +((1 / target) * 100).toFixed(2),
        multiplier: won ? multiplier : 0,
      },
    };
  }
}
