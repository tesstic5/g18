// apps/api/src/engine/games/HiLoGame.ts — card streak with dynamic payouts (v3 GAME 9 + v8)
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { mulberry32 } from './MinesGame';

const RANKS = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
] as const;
const RANK_VALUE: Record<string, number> = Object.fromEntries(
  RANKS.map((r, i) => [r, i + 2])
);

export function cardFromRaw(raw: number): { rank: string; suit: string } {
  const rng = mulberry32(Math.floor(raw * 0xffffffff));
  const idx = Math.floor(rng() * 52);
  return { rank: RANKS[Math.floor(idx / 4)]!, suit: ['♠', '♥', '♦', '♣'][idx % 4]! };
}

export class HiLoGame extends BaseGame {
  readonly slug = 'hi-lo';

  resolve({ rawOutcome, config, choices }: ResolveParams): GameHandlerResult {
    const current = (choices as { currentRank?: string }).currentRank ?? '7';
    const guess = (choices as { guess?: 'higher' | 'lower' }).guess ?? 'higher';
    const next = cardFromRaw(rawOutcome);
    const cv = RANK_VALUE[current] ?? 7;
    const nv = RANK_VALUE[next.rank] ?? 7;
    const won = guess === 'higher' ? nv > cv : nv < cv;

    // D-089: correct rank math. RANKS are 2..A (values 2..14), so ranks strictly
    // above value cv = (14 - cv), below = (cv - 2). Card is drawn from the full
    // 52-card deck (current card not removed), so probability = above/52.
    const above = (14 - cv) * 4,
      below = (cv - 2) * 4;
    const prob = guess === 'higher' ? above / 52 : below / 52;
    // On an Ace nothing is higher and on a 2 nothing is lower, so prob is 0.
    // `0.97 / (prob || 0.5)` used to advertise 1.94x on a bet that could never
    // be won. An impossible guess pays nothing and is flagged so the UI can say
    // so rather than showing fake odds.
    const impossible = prob <= 0;
    const multiplier = won && !impossible ? 0.97 / prob : 0;

    return {
      result: won && !impossible ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        current,
        next: next.rank,
        suit: next.suit,
        guess,
        win: won && !impossible,
        impossible,
        probability: +(prob * 100).toFixed(1),
        multiplier: +multiplier.toFixed(2),
      },
    };
  }
}
