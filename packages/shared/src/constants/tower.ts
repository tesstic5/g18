// packages/shared/src/constants/tower.ts — Tower board + per-floor payouts.
//
// HOW PAYOUTS WORK
// ----------------
// The live climb (`towerSession` in apps/api) pays `ladder[floor]` on a
// successful pick. Admin owns that table: `configJson.difficulties[id].payout_ladder`
// (preferred) or top-level `payout_ladder_{easy,medium,hard,expert}`.
//
// If neither is a full 10-rung list, the engine falls back to the FAIR
// formula 0.96 / P(survive f). Fair expert floor 10 is ~9.4 million × —
// that is why the seed ships an explicit, operator-sized table and the
// admin panel edits it per floor.
//
// Client and server MUST resolve the board through `resolveTowerBoard` so
// the labels on screen match what cashout actually pays.
export const TOWER_FLOORS = 10;

export const TOWER_DIFFICULTY_IDS = ['easy', 'medium', 'hard', 'expert'] as const;
export type TowerDifficulty = (typeof TOWER_DIFFICULTY_IDS)[number];

export const DEFAULT_TOWER_DIFFS: Record<
  TowerDifficulty,
  { columns_per_floor: number; traps_per_floor: number }
> = {
  easy: { columns_per_floor: 3, traps_per_floor: 1 },
  medium: { columns_per_floor: 4, traps_per_floor: 2 },
  hard: { columns_per_floor: 4, traps_per_floor: 3 },
  expert: { columns_per_floor: 5, traps_per_floor: 4 },
};

/**
 * Seeded / "recommended" ladders. First floor sits just under fair
 * (~88–93% RTP); later floors grow slower than the fair 1/p doubling so
 * liability stays in the hundreds of ×, not millions. Admin can raise or
 * lower every rung from the panel.
 */
export const DEFAULT_TOWER_LADDERS: Record<TowerDifficulty, number[]> = {
  easy: [1.4, 1.75, 2.2, 2.75, 3.45, 4.3, 5.4, 6.75, 8.4, 10.5],
  medium: [1.85, 2.6, 3.65, 5.1, 7.1, 10, 14, 19.5, 27, 38],
  hard: [3.5, 5.5, 8.6, 13.5, 21, 33, 52, 82, 130, 200],
  expert: [4.4, 7.5, 13, 22, 38, 65, 110, 185, 310, 520],
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function posInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

/** Fair 0.96 / P(survive f) table. Tests and the no-config fallback use this. */
export function fairTowerLadder(
  cols: number,
  traps: number,
  floors = TOWER_FLOORS
): number[] {
  const safe = Math.max(1, cols - traps);
  const p = safe / Math.max(1, cols);
  const out: number[] = [];
  for (let f = 1; f <= floors; f++) out.push(+(0.96 / Math.pow(p, f)).toFixed(2));
  return out;
}

/** A full-length numeric ladder, or null if missing/short/non-numeric. */
export function parseTowerLadder(raw: unknown, floors = TOWER_FLOORS): number[] | null {
  if (!Array.isArray(raw) || raw.length < floors) return null;
  const nums = raw.slice(0, floors).map((n) => (typeof n === 'number' ? n : Number(n)));
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return nums;
}

export function resolveTowerBoard(
  configJson: unknown,
  difficulty: string,
  floors = TOWER_FLOORS
): { cols: number; traps: number; ladder: number[] } {
  const cj = isObj(configJson) ? configJson : {};
  const diffs = isObj(cj.difficulties) ? cj.difficulties : {};
  const named = isObj(diffs[difficulty]) ? diffs[difficulty] : {};
  const fallback =
    DEFAULT_TOWER_DIFFS[difficulty as TowerDifficulty] ?? DEFAULT_TOWER_DIFFS.medium;
  const cols = posInt(named.columns_per_floor) ?? fallback.columns_per_floor;
  const traps = posInt(named.traps_per_floor) ?? fallback.traps_per_floor;
  const nested = parseTowerLadder(named.payout_ladder, floors);
  const top = parseTowerLadder(cj[`payout_ladder_${difficulty}`], floors);
  const ladder = nested ?? top ?? fairTowerLadder(cols, traps, floors);
  return { cols, traps, ladder };
}

/** True when configJson already has a full ladder for this difficulty. */
export function towerHasConfiguredLadder(
  configJson: unknown,
  difficulty: string,
  floors = TOWER_FLOORS
): boolean {
  const cj = isObj(configJson) ? configJson : {};
  const diffs = isObj(cj.difficulties) ? cj.difficulties : {};
  const named = isObj(diffs[difficulty]) ? diffs[difficulty] : {};
  return (
    parseTowerLadder(named.payout_ladder, floors) !== null ||
    parseTowerLadder(cj[`payout_ladder_${difficulty}`], floors) !== null
  );
}
