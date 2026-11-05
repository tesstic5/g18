// Pure decision for crash leader takeover. Redis is the clock; Postgres is the
// debt. A new leader must SETTLE a round whose crash is already determined,
// RESUME a still-flying round, and only REFUND a round that never took off.
import { crashMultiplierAt } from './AviatorGame';

export type CrashSalvageKind = 'settle' | 'resume' | 'refund' | 'none';

export function growthRateFromConfig(config: unknown): number {
  const cfg = (config as { configJson?: { growth_rate?: number } } | undefined)
    ?.configJson;
  return Number(cfg?.growth_rate ?? 0.00016);
}

export function crashSalvageKind(
  state: {
    status: string;
    startedAt: number | null;
    crashedAt: number | null;
    crashPoint: number;
    config?: unknown;
  } | null,
  now = Date.now()
): CrashSalvageKind {
  if (!state) return 'none';
  if (state.status === 'CRASHED' || state.crashedAt) return 'settle';
  if (state.status === 'FLYING' && state.startedAt != null) {
    const m = crashMultiplierAt(
      growthRateFromConfig(state.config),
      now - state.startedAt
    );
    return m >= state.crashPoint ? 'settle' : 'resume';
  }
  if (state.status === 'WAITING' || state.status === 'BETTING') return 'refund';
  return 'none';
}
