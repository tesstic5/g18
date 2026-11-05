// packages/shared/src/constants/plinko.ts — multi-ball stake math.
//
// Each ball is a FULL copy of the displayed bet, not a slice of it.
// 16 balls at ₨100 charges ₨1,600 and pays Σ(bucket × ₨100).
// The engine still reports payoutMultiplier as the MEAN of the bucket
// multipliers so credit = chargedStake × mean = perBall × Σ multipliers.
export const PLINKO_MAX_BALLS = 16;

export function plinkoBallCount(choices: unknown): number {
  const raw = (choices as { balls?: unknown } | null | undefined)?.balls;
  const n = raw === undefined || raw === null ? 1 : Number(raw);
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(PLINKO_MAX_BALLS, n);
}

/** Total money to debit for a Plinko drop. `perBallAmount` is the UI stake. */
export function plinkoChargedStake(perBallAmount: number, choices: unknown): number {
  const n = Number(perBallAmount);
  if (!Number.isFinite(n)) return n;
  return +(n * plinkoBallCount(choices)).toFixed(2);
}
