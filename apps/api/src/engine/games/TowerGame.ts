// apps/api/src/engine/games/TowerGame.ts — floors × columns, climb + cashout (v3 GAME 8 + v8)
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { mulberry32 } from './MinesGame';

interface TowerChoices {
  difficulty?: string;
  floor?: number;
  column?: number;
  safeCount?: number;
}

export class TowerGame extends BaseGame {
  readonly slug = 'tower';

  resolve({
    rawOutcome,
    config,
    choices,
    forceMode,
  }: ResolveParams): GameHandlerResult {
    const cfg = config.configJson as {
      floors?: number;
      difficulties?: Record<
        string,
        {
          columns_per_floor: number;
          traps_per_floor: number;
          payout_ladder?: number[];
        }
      >;
      payout_ladder_medium?: number[];
      payout_ladder_easy?: number[];
      payout_ladder_hard?: number[];
      payout_ladder_expert?: number[];
    };
    const { difficulty = 'medium', floor = 0, column = 0 } = choices as TowerChoices;
    const d = cfg.difficulties?.[difficulty] ?? {
      columns_per_floor: 4,
      traps_per_floor: 2,
    };
    // Prefer the nested admin table, then top-level, then the unused-path
    // default. Live play goes through towerSession, not this resolve().
    const nested = d.payout_ladder;
    const ladder =
      (Array.isArray(nested) && nested.length > 0 ? nested : undefined) ??
      cfg[`payout_ladder_${difficulty}` as 'payout_ladder_medium'] ??
      cfg.payout_ladder_medium ??
      defaultLadder();
    const rng = mulberry32(Math.floor(rawOutcome * 0xffffffff) + floor);
    const traps = new Set<number>();
    while (traps.size < d.traps_per_floor)
      traps.add(Math.floor(rng() * (d.columns_per_floor ?? 4)));

    // D-089: the grid is the truth — win/lose from trap positions only, NOT
    // the global winRate. Admin force-override still works (test tool).
    const safe =
      forceMode === 'FORCE_WIN'
        ? true
        : forceMode === 'FORCE_LOSE'
          ? false
          : !traps.has(column);
    const multiplier = safe ? (ladder[Math.min(floor, ladder.length - 1)] ?? 0) : 0;
    return {
      result: safe ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        floor,
        column,
        difficulty,
        columns: d.columns_per_floor,
        safe,
        currentMultiplier: safe ? multiplier : 0,
        trapPositions: safe ? null : [...traps],
      },
    };
  }
}

function defaultLadder(): number[] {
  // Unused-for-play path (towerSession is live). Keep a modest medium table
  // so this handler cannot resurrect the 100× flatline.
  return [1.85, 2.6, 3.65, 5.1, 7.1, 10, 14, 19.5, 27, 38];
}
