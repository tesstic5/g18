// apps/api/src/engine/games/PlinkoGame.ts — ball drops to server-determined buckets.
//
// PHYSICS FIX
// -----------
// The bucket used to be chosen from a flat weight array — effectively UNIFORM
// over the rows+1 slots. Real Plinko is a Galton board: the ball makes one
// left/right decision at each of the `rows` peg rows, so the landing slot is
// BINOMIAL, P(slot i) = C(rows, i) / 2^rows.
//
// The consequences of the uniform picker were severe:
//   • On a 16-row board the two jackpot edge slots came up 5.88% of the time
//     each instead of 0.0015% — about 3,855x too often.
//   • The animation walked the ball down through pegs and then TELEPORTED it to
//     a slot the physics would essentially never reach, so the drop looked
//     visibly faked.
//   • The payout tables were calibrated for a uniform draw, so they had to use
//     tiny edge multipliers (3.3x top prize) — Plinko's whole appeal is the big
//     edge payout, and every risk level shipped the SAME table, making "Low",
//     "Medium" and "High risk" identical games with different labels.
//
// Now each ball walks the board for real: `rows` provably-fair coin flips
// derived from the round's rawOutcome, bucket = number of rights. The payout
// tables in the DB are re-calibrated against the binomial distribution so every
// risk level once returned ~96%, with real risk separation (low tops out ~2x,
// high ~136x on 16 rows). v1.3.9 re-ceiled that to a 2x / 6x / 12x ladder
// per operator order (see defaultTable).
import { AppError } from '../../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { mulberry32 } from './MinesGame';
import type { GameConfig } from '../../../src/generated/prisma/client';

/**
 * Walk one ball down a Galton board.
 * Returns the landing slot (0..rows) AND the left/right path, so the client can
 * animate the exact route the server rolled instead of inventing one.
 */
export function dropBall(
  rng: () => number,
  rows: number
): { bucket: number; path: Array<0 | 1> } {
  const path: Array<0 | 1> = [];
  let bucket = 0;
  for (let r = 0; r < rows; r++) {
    const right: 0 | 1 = rng() < 0.5 ? 0 : 1;
    path.push(right);
    bucket += right;
  }
  return { bucket, path };
}

/** Binomial probability of each slot — used by the RTP self-check in tests. */
export function slotProbabilities(rows: number): number[] {
  const out: number[] = [];
  let c = 1; // C(rows, 0)
  for (let i = 0; i <= rows; i++) {
    out.push(c / Math.pow(2, rows));
    c = (c * (rows - i)) / (i + 1);
  }
  return out;
}

const ALLOWED_ROWS = [8, 12, 16];
const ALLOWED_RISKS = ['low', 'medium', 'high'];

/**
 * M-02 second line of defence (route schema rejects too): an unsupported
 * board size was previously SNAPPED to 12 rows — silently replaying the wager
 * on a board the player never picked. Reject instead; only the three
 * RTP-checked boards exist.
 */
function parsePlinkoChoices(choices: Record<string, unknown>): {
  risk: string;
  rows: number;
  balls: number;
} {
  const c = choices as { risk?: unknown; rows?: unknown; balls?: unknown };
  const riskRaw = c.risk === undefined ? 'medium' : String(c.risk).toLowerCase();
  if (!ALLOWED_RISKS.includes(riskRaw))
    throw new AppError(
      ERROR_CODES.GAME_INVALID_CHOICES,
      422,
      `Unknown plinko risk: ${String(c.risk)}`
    );
  const rowsRaw = c.rows === undefined ? 12 : Number(c.rows);
  if (!ALLOWED_ROWS.includes(rowsRaw))
    throw new AppError(
      ERROR_CODES.GAME_INVALID_CHOICES,
      422,
      `Unsupported plinko board size: ${String(c.rows)} (only 8/12/16 have priced tables)`
    );
  const ballsRaw = c.balls === undefined ? 1 : Number(c.balls);
  if (!Number.isInteger(ballsRaw) || ballsRaw < 1 || ballsRaw > 16)
    throw new AppError(
      ERROR_CODES.GAME_INVALID_CHOICES,
      422,
      'Plinko balls must be 1..16'
    );
  return { risk: riskRaw, rows: rowsRaw, balls: ballsRaw };
}

export class PlinkoGame extends BaseGame {
  readonly slug = 'plinko';

  /** P(mean bucket multiplier > 1) — exact DP over the binomial slot law.
   *  Independent fair balls are added as weighted distributions, so the win
   *  chance reflects the real table, not a Gaussian guess. */
  override fairWinChance(choices: Record<string, unknown>, config: GameConfig): number {
    const cfg = config.configJson as {
      risk_levels?: Record<string, Record<string, number[]>>;
    };
    const { risk, rows, balls } = parsePlinkoChoices(choices);
    const riskTable = cfg.risk_levels?.[risk]?.[String(rows)];
    const multipliers =
      Array.isArray(riskTable) && riskTable.length === rows + 1
        ? riskTable
        : defaultTable(risk, rows);
    const slotP = slotProbabilities(rows);
    // Distribution of the SUM of bucket multipliers across `balls` drops,
    // keyed on stringified sum (doubles are fine as float keys via toFixed).
    let dist: Map<string, number> = new Map([['0', 1]]);
    for (let b = 0; b < balls; b++) {
      const next = new Map<string, number>();
      for (const [sumStr, prob] of dist) {
        const sum = Number(sumStr);
        for (let i = 0; i <= rows; i++) {
          const key = (sum + (multipliers[i] ?? 1)).toFixed(6);
          next.set(key, (next.get(key) ?? 0) + prob * slotP[i]!);
        }
      }
      dist = next;
    }
    let pWin = 0;
    for (const [sumStr, prob] of dist) if (Number(sumStr) / balls > 1) pWin += prob;
    return pWin;
  }

  resolve(params: ResolveParams): GameHandlerResult {
    return this.resolveDecided(params);
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
    choices,
  }: ResolveParams): GameHandlerResult {
    const cfg = config.configJson as {
      risk_levels?: Record<string, Record<string, number[]>>;
    };
    // M-02: reject — never re-board — choices outside the priced tables.
    const { risk, rows, balls } = parsePlinkoChoices(choices);

    const riskTable = cfg.risk_levels?.[risk]?.[String(rows)];
    const multipliers =
      Array.isArray(riskTable) && riskTable.length === rows + 1
        ? riskTable
        : defaultTable(risk, rows);

    // One provably-fair RNG stream for the whole round; each ball consumes
    // `rows` flips from it, so the result is fully reproducible from rawOutcome.
    const rng = mulberry32(Math.floor(rawOutcome * 0xffffffff));
    const buckets: number[] = [];
    const paths: Array<Array<0 | 1>> = [];
    for (let b = 0; b < balls; b++) {
      const { bucket, path } = dropBall(rng, rows);
      buckets.push(bucket);
      paths.push(path);
    }

    const bucketMultipliers = buckets.map((bi) => multipliers[bi] ?? 1);
    // Mean of per-ball multipliers. The route charges amount × balls, so
    // credit = chargedStake × aggregate = perBall × Σ multipliers.
    const aggregate = bucketMultipliers.reduce((s, m) => s + m, 0) / balls;

    // WIN = got back MORE than the stake. Most buckets pay below 1x, so a
    // 0.24x landing is a loss that returns a fraction of the stake — it must
    // not be reported as a win (the player would see a green "YOU WIN" banner
    // while losing 76% of their money).
    const won = aggregate >= 1;
    const partialRefund = aggregate > 0 && aggregate < 1;

    return {
      result: won ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(aggregate, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        rows,
        risk,
        balls,
        buckets,
        bucketMultipliers,
        paths,
        aggregate: +aggregate.toFixed(4),
        multiplier: +aggregate.toFixed(4),
        win: won,
        partialRefund,
        multipliers,
      },
    };
  }
}

/**
 * Fallback tables — v1.3.9 ladder 2x / 6x / 12x max with dead 0x centre slots
 * (see the in-function comment for the calibration). Mirrors prisma/seed.ts.
 */
export function defaultTable(risk: string, rows: number): number[] {
  // v1.3.9 (operator order 2026-08-23): caps LADDERED 2x / 6x / 12x — a hard
  // bucket can NEVER exceed 12x (previously >130x crept through). Dead
  // centre buckets pay exactly 0 (no partial refund): 1 slot on medium,
  // 3 slots on high. RTP low ~96%, medium ~82.5-83.6%, high ~46-48.8%.
  // Mirrors prisma/seed.ts risk_levels EXACTLY — keep in sync (the
  // payout-ceilings test parses the seed to prove it).
  const T: Record<string, Record<number, number[]>> = {
    low: {
      8: [2, 1.34, 1.02, 0.904, 0.887, 0.904, 1.02, 1.34, 2],
      12: [2, 1.56, 1.25, 1.06, 0.959, 0.924, 0.919, 0.924, 0.959, 1.06, 1.25, 1.56, 2],
      16: [
        2, 1.68, 1.4, 1.21, 1.07, 0.992, 0.95, 0.935, 0.933, 0.935, 0.95, 0.992, 1.07,
        1.21, 1.4, 1.68, 2,
      ],
    },
    medium: {
      8: [6, 3, 1.3, 0.7, 0, 0.7, 1.3, 3, 6],
      12: [6, 4.5, 3.5, 2, 1.1, 0.55, 0, 0.55, 1.1, 2, 3.5, 4.5, 6],
      16: [6, 5.5, 5, 4, 2.5, 1.6, 0.9, 0.5, 0, 0.5, 0.9, 1.6, 2.5, 4, 5, 5.5, 6],
    },
    high: {
      8: [12, 3.5, 0.8, 0, 0, 0, 0.8, 3.5, 12],
      12: [12, 7, 4, 1.6, 0.5, 0, 0, 0, 0.5, 1.6, 4, 7, 12],
      16: [12, 9, 7, 4.5, 2.2, 1, 0.4, 0, 0, 0, 0.4, 1, 2.2, 4.5, 7, 9, 12],
    },
  };
  return T[risk]?.[rows] ?? T.medium![12]!;
}
