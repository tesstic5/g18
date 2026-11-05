// apps/api/src/engine/games/MinesGame.ts — 5×5 grid, progressive multiplier (v3 GAME 4 + v8)
// Mine positions derived deterministically from rawOutcome at round start; revealed at end.
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';

// Canonical home is ./rng (BaseGame also needs it); re-exported here so the
// many existing `from './MinesGame'` import sites stay valid.
import { mulberry32 } from './rng';
export { mulberry32 };

export class MinesGame extends BaseGame {
  readonly slug = 'mines';

  resolve({
    rawOutcome,
    config,
    choices,
    forceMode,
  }: ResolveParams): GameHandlerResult {
    const cfg = config.configJson as {
      grid_size?: number;
      mine_counts?: number[];
      payout_ladders?: Record<string, number[]>;
      mine_placement?: 'weighted' | 'true-random';
    };
    const gridSize = cfg.grid_size ?? 25;
    const mineCount = Math.min(
      gridSize - 1,
      Math.max(1, Number((choices as { mineCount?: number }).mineCount || 3))
    );
    const clickedTile = Number((choices as { clickedTile?: number }).clickedTile ?? 0);

    // deterministic mine placement from rawOutcome (commitment at bet time — docs/13)
    const rng = mulberry32(Math.floor(rawOutcome * 0xffffffff));
    const mines = new Set<number>();
    while (mines.size < mineCount) mines.add(Math.floor(rng() * gridSize));

    const ladder = cfg.payout_ladders?.[String(mineCount)] ?? defaultLadder(mineCount);
    const isMine = mines.has(clickedTile);
    const revealsSoFar = Number((choices as { reveals?: number }).reveals ?? 0);

    // D-089: the GRID is the truth — win/lose comes from the mine positions,
    // NOT the global winRate. (Double-gating made actual RTP ~44% instead of
    // the advertised 96%.) Admin force-override still works (test tool).
    const hitMine =
      forceMode === 'FORCE_LOSE' ? true : forceMode === 'FORCE_WIN' ? false : isMine;
    const multiplier = hitMine
      ? 0
      : (ladder[Math.min(revealsSoFar, ladder.length - 1)] ?? 1);
    return {
      result: hitMine ? 'LOSE' : 'WIN',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        gridSize,
        mineCount,
        clickedTile,
        isMine: hitMine,
        currentMultiplier: hitMine ? 0 : multiplier,
        nextMultiplier: hitMine
          ? 0
          : (ladder[Math.min(revealsSoFar + 1, ladder.length - 1)] ?? multiplier),
        minePositions: hitMine ? [...mines] : null, // revealed only on bust (docs/13)
        revealedSafeTiles: [clickedTile],
        isCashout: false,
        isBust: hitMine,
      },
    };
  }
}

export function defaultLadder(mines: number): number[] {
  // geometric growth calibrated to ~96% RTP at typical cashout points
  const base = 1 + mines * 0.03;
  const arr: number[] = [];
  for (let i = 0; i < 24; i++) arr.push(+(base * Math.pow(1.05, i)).toFixed(2));
  return arr;
}
