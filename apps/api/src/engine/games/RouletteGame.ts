// apps/api/src/engine/games/RouletteGame.ts — European single-zero wheel with the
// FULL table (D-093): straight, split, street, corner, six-line, dozen, column,
// red/black/odd/even/low/high — each pays the standard amount.
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';

const RED_POCKETS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);
export const pocketColor = (n: number): 'red' | 'black' | 'green' =>
  n === 0 ? 'green' : RED_POCKETS.has(n) ? 'red' : 'black';

export function defaultPayouts(): Record<string, number> {
  return {
    straight: 36,
    split: 18,
    street: 12,
    corner: 9,
    six_line: 6,
    dozen: 3,
    column: 3,
    red: 2,
    black: 2,
    odd: 2,
    even: 2,
    low: 2,
    high: 2,
  };
}

// Layout helpers (European table: 12 columns × 3 rows; column c (1-based)
// contains {3c-2, 3c-1, 3c} stacked bottom→top).
export const COLUMN_NUMBERS: Record<number, number[]> = {
  1: Array.from({ length: 12 }, (_, i) => 3 * i + 1), // 1,4,7,…34
  2: Array.from({ length: 12 }, (_, i) => 3 * i + 2), // 2,5,8,…35
  3: Array.from({ length: 12 }, (_, i) => 3 * i + 3), // 3,6,9,…36
};

/** How many pockets each multi-pocket bet type is priced to cover. */
const COVERAGE: Record<string, number> = {
  split: 2,
  street: 3,
  corner: 4,
  six_line: 6,
};

interface RouletteChoice {
  type: string;
  number?: number; // straight: the pocket
  numbers?: number[]; // split/street/corner/six_line: covered pockets
  column?: number; // column 1-3
  dozen?: number; // dozen: which dozen (1-3)
}

export class RouletteGame extends BaseGame {
  readonly slug = 'roulette';

  /** Pockets covered by the bet ÷ 37. Malformed multi-pocket bets cover 0. */
  static coveredPockets(bet: RouletteChoice): number {
    switch (bet.type) {
      case 'straight':
        return Number.isInteger(bet.number) && bet.number! >= 0 && bet.number! <= 36
          ? 1
          : 0;
      case 'split':
      case 'street':
      case 'corner':
      case 'six_line': {
        const need = COVERAGE[bet.type]!;
        const nums = bet.numbers ?? [];
        const wellFormed =
          nums.length === need &&
          new Set(nums).size === need &&
          nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 36);
        return wellFormed ? need : 0;
      }
      case 'column':
        return (COLUMN_NUMBERS[bet.column ?? 1] ?? null) ? 12 : 0;
      case 'red':
      case 'black':
      case 'odd':
      case 'even':
      case 'low':
      case 'high':
        return 18;
      case 'dozen-1':
      case 'dozen-2':
      case 'dozen-3':
        return 12;
      case 'dozen':
        // M-01: only a well-formed dozen selection is priced (0 = reject
        // upstream as impossible rather than silently mispriced).
        return Number.isInteger(bet.dozen) && bet.dozen! >= 1 && bet.dozen! <= 3
          ? 12
          : 0;
      default:
        return 0;
    }
  }

  override fairWinChance(choices: Record<string, unknown>): number {
    const bet = (choices as { bet?: RouletteChoice }).bet ?? { type: 'red' };
    return RouletteGame.coveredPockets(bet) / 37;
  }

  resolve(params: ResolveParams): GameHandlerResult {
    return this.resolveDecided(params);
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
    choices,
  }: ResolveParams): GameHandlerResult {
    const pocket = Math.min(36, Math.floor(rawOutcome * 37)); // 0-36
    const bet = (choices as { bet?: RouletteChoice }).bet ?? { type: 'red' };
    const payouts =
      (config.configJson as { payouts?: Record<string, number> }).payouts ??
      defaultPayouts();

    let won = false;
    switch (bet.type) {
      case 'straight':
        won = bet.number === pocket;
        break;
      // C-1: a multi-pocket bet must cover EXACTLY the number of pockets its
      // payout is priced for, with no duplicates. Without this,
      // { type:'split', numbers:[0..36] } covered every pocket and won every
      // spin at 18x — a measured 1800% RTP. The route-level zod schema catches
      // this too; this is the independent second line of defence, because a
      // bug in one layer of a money path must not be enough on its own.
      case 'split':
      case 'street':
      case 'corner':
      case 'six_line': {
        const need = COVERAGE[bet.type]!;
        const nums = bet.numbers ?? [];
        const distinct = new Set(nums);
        const wellFormed =
          nums.length === need &&
          distinct.size === need &&
          nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 36);
        won = wellFormed && distinct.has(pocket);
        break;
      }
      case 'column':
        won = (COLUMN_NUMBERS[bet.column ?? 1] ?? []).includes(pocket);
        break;
      case 'red':
        won = pocketColor(pocket) === 'red';
        break;
      case 'black':
        won = pocketColor(pocket) === 'black';
        break;
      case 'odd':
        won = pocket !== 0 && pocket % 2 === 1;
        break;
      case 'even':
        won = pocket !== 0 && pocket % 2 === 0;
        break;
      case 'low':
        won = pocket >= 1 && pocket <= 18;
        break;
      case 'high':
        won = pocket >= 19 && pocket <= 36;
        break;
      case 'dozen-1':
        won = pocket >= 1 && pocket <= 12;
        break;
      case 'dozen-2':
        won = pocket >= 13 && pocket <= 24;
        break;
      case 'dozen-3':
        won = pocket >= 25 && pocket <= 36;
        break;
      // M-01 / D-093: the validator also accepts { type:'dozen', dozen:1|2|3 }.
      // Without this case such a bet ALWAYS lost — it was priced at 12/37 and
      // paid out as LOSE on every pocket. Resolve it from its `dozen` field.
      case 'dozen':
        won =
          Number.isInteger(bet.dozen) &&
          bet.dozen! >= 1 &&
          bet.dozen! <= 3 &&
          pocket >= (bet.dozen! - 1) * 12 + 1 &&
          pocket <= bet.dozen! * 12;
        break;
      default:
        won = false;
    }
    // D-093: dozens live under the `dozen` payout key (defaultPayouts has no
    // dozen-1/2/3 keys — this silently paid 2× instead of 3× before).
    const payoutKey = bet.type.startsWith('dozen-') ? 'dozen' : bet.type;
    const multiplier = won ? (payouts[payoutKey] ?? 2) : 0;
    return {
      result: won ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        pocket,
        color: pocketColor(pocket),
        bet,
        win: won,
        multiplier: won ? multiplier : 0,
      },
    };
  }
}
