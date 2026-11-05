// packages/shared/src/utils/validateConfig.ts — THE canonical config validator (docs/06 + docs/20 rule 4).
// Pure function: used by the API (in-request save validation) AND the admin editor (live preview).
import { LIMITS } from '../constants/limits';

export interface ValidationResult {
  valid: boolean;
  calculatedRtp: number;
  houseEdge: number;
  error?: string;
}

export function validateConfig(input: {
  winRate: number;
  payoutWeights: Array<{ multiplier: number; weight: number }>;
  maxWinMultiplier: number;
}): ValidationResult {
  if (!Number.isFinite(input.winRate) || !Number.isFinite(input.maxWinMultiplier)) {
    return {
      valid: false,
      calculatedRtp: 0,
      houseEdge: 100,
      error: 'Win rate and maximum multiplier must be finite numbers',
    };
  }
  if (!Array.isArray(input.payoutWeights) || input.payoutWeights.length === 0) {
    return {
      valid: false,
      calculatedRtp: 0,
      houseEdge: 100,
      error: 'At least one payout weight is required',
    };
  }
  if (
    input.payoutWeights.some(
      (p) =>
        !Number.isFinite(p.multiplier) ||
        p.multiplier < 0 ||
        !Number.isFinite(p.weight) ||
        p.weight <= 0
    )
  ) {
    return {
      valid: false,
      calculatedRtp: 0,
      houseEdge: 100,
      error: 'Every payout multiplier must be >= 0 and every weight must be > 0',
    };
  }
  const totalWeight = input.payoutWeights.reduce((s, p) => s + p.weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0)
    return {
      valid: false,
      calculatedRtp: 0,
      houseEdge: 100,
      error: 'Payout weights must sum to > 0',
    };
  const avgPayout = input.payoutWeights.reduce(
    (s, p) => s + (p.multiplier * p.weight) / totalWeight,
    0
  );
  const theoreticalRtp = (input.winRate / 100) * avgPayout * 100;

  if (theoreticalRtp > LIMITS.RTP_CEILING) {
    return {
      valid: false,
      calculatedRtp: theoreticalRtp,
      houseEdge: 100 - theoreticalRtp,
      error:
        `Calculated RTP is ${theoreticalRtp.toFixed(2)}% which exceeds the ${LIMITS.RTP_CEILING}% ceiling. ` +
        `Reduce win rate from ${input.winRate}% or lower payout weights. Average payout: ${avgPayout.toFixed(2)}×`,
    };
  }
  if (input.winRate < LIMITS.WIN_RATE_MIN || input.winRate > LIMITS.WIN_RATE_MAX) {
    return {
      valid: false,
      calculatedRtp: theoreticalRtp,
      houseEdge: 100 - theoreticalRtp,
      error: `Win rate must be between ${LIMITS.WIN_RATE_MIN}% and ${LIMITS.WIN_RATE_MAX}%`,
    };
  }
  if (
    input.maxWinMultiplier <= 0 ||
    input.maxWinMultiplier > LIMITS.MAX_WIN_MULTIPLIER_LIMIT
  ) {
    return {
      valid: false,
      calculatedRtp: theoreticalRtp,
      houseEdge: 100 - theoreticalRtp,
      error: `Max win multiplier must be greater than 0 and cannot exceed ${LIMITS.MAX_WIN_MULTIPLIER_LIMIT}×`,
    };
  }
  return {
    valid: true,
    calculatedRtp: theoreticalRtp,
    houseEdge: 100 - theoreticalRtp,
  };
}
