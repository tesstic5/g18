// apps/api/src/engine/games/WingoGame.ts — pooled color+number prediction (v3 GAME 3)
// Number 0-9 drawn per round from number_weights; color derived (real WinGo rules):
//   GREEN = 1,3,7,9 · RED = 2,4,6,8 · VIOLET = 0,5 · BIG = 5-9 · SMALL = 0-4 (D-106).
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { colorOf, isBig, DEFAULT_WINGO_PAYOUTS } from './wingo-book';

export { colorOf, isBig };

export function drawNumber(
  raw: number,
  weights: Array<{ number: number; weight: number }>
): number {
  const total = weights.reduce((s, w) => s + w.weight, 0) || 10;
  let cumulative = 0;
  for (const w of weights) {
    cumulative += w.weight / total;
    if (raw <= cumulative) return w.number;
  }
  return weights[weights.length - 1]!.number;
}

export class WingoGame extends BaseGame {
  readonly slug = 'wingo';

  resolve({ rawOutcome, config, choices }: ResolveParams): GameHandlerResult {
    const cfg = config.configJson as {
      number_weights?: Array<{ number: number; weight: number }>;
      payouts?: {
        red: number;
        green: number;
        violet: number;
        number: number;
        big: number;
        small: number;
      };
    };
    const weights =
      cfg.number_weights ??
      Array.from({ length: 10 }, (_, number) => ({ number, weight: 10 }));
    const number = drawNumber(rawOutcome, weights);
    const color = colorOf(number);
    const choice = (choices as { choice?: string | number }).choice;

    // choice is 'red'|'green'|'violet' (color), 'big'|'small' (size) or a number 0-9
    const won =
      choice === color ||
      choice === number ||
      (choice === 'big' && isBig(number)) ||
      (choice === 'small' && !isBig(number));
    // Live shared WinGo always pays 1.96× (see wingo-book.ts). Solo/demo
    // resolve uses the same table so the two paths never disagree.
    const payouts = DEFAULT_WINGO_PAYOUTS;
    const multiplier = won
      ? typeof choice === 'number'
        ? payouts.number
        : payouts[choice as 'red' | 'green' | 'violet' | 'big' | 'small']
      : 0;

    return {
      result: won ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        number,
        color,
        choice,
        win: won,
        multiplier: won ? multiplier : 0,
      },
    };
  }
}
