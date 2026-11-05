// apps/api/src/engine/games/CoinFlipGame.ts — binary choice (v3 GAME 7 + v8)
//
// M-1: this game was neither fair nor provably fair.
//
// The old handler read `isWin` — a boolean the engine derives from the admin
// `winRate` — and then worked BACKWARDS to a coin face:
//
//     const side = isWin ? choice : (choice === 'heads' ? 'tails' : 'heads');
//
// Two consequences, both bad:
//
//  1. NOT PROVABLY FAIR. `rawOutcome` (the HMAC-derived number that the whole
//     provably-fair system exists to commit to) was never touched. A player
//     replaying the seed pair could not reproduce the flip, because the flip
//     was not derived from it. The platform advertises provable fairness on
//     every game page; for this one it was not true.
//
//  2. WRONG PRICE. Seeded winRate is 48 and payout 1.95, i.e. 0.48 x 1.95 =
//     93.6% RTP — noticeably worse than the 96% advertised, and worse than the
//     house needs.
//
// Now the coin is decided by `rawOutcome` (a true 50/50 split of the verifiable
// number) and priced at 1.92x, giving 0.5 x 1.92 = 96.00% exactly.
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';

/** 0.5 x 1.92 = 96.00% RTP. */
const FAIR_PAYOUT = 1.92;

export class CoinFlipGame extends BaseGame {
  readonly slug = 'coin-flip';

  override fairWinChance(): number {
    return 0.5;
  }

  resolve(params: ResolveParams): GameHandlerResult {
    return this.resolveDecided(params);
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
    choices,
  }: ResolveParams): GameHandlerResult {
    const choice =
      (choices as { choice?: string }).choice === 'tails' ? 'tails' : 'heads';
    // The verifiable number decides the coin — nothing else.
    const side = rawOutcome < 0.5 ? 'heads' : 'tails';
    const win = side === choice;
    const payout = Number(
      (config.configJson as { payout?: number }).payout ?? FAIR_PAYOUT
    );
    return {
      result: win ? 'WIN' : 'LOSE',
      payoutMultiplier: win ? Math.min(payout, Number(config.maxWinMultiplier)) : 0,
      mappedOutcome: { side, choice, win, multiplier: win ? payout : 0 },
    };
  }
}
