// apps/web/src/lib/crash-bet.ts — D-095: tiny pub/sub so the crash visual can
// show YOUR bet riding the curve. The game page records the bet amount when
// placed; AviatorVisual subscribes and renders the chip.
type MyCrashBet = { amount: number; placedAt: number } | null;
let current: MyCrashBet = null;
const listeners = new Set<() => void>();

export function setMyCrashBet(b: { amount: number }): void {
  current = { ...b, placedAt: Date.now() };
  listeners.forEach((l) => l());
}
export function getMyCrashBet(): MyCrashBet {
  return current;
}
export function clearMyCrashBet(): void {
  current = null;
  listeners.forEach((l) => l());
}
export function onMyCrashBet(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// ── v1.3.4: crash-state join snapshot ────────────────────────────────────────
// One HTTP call shared by the visual (status + history ticker) and the bet
// slots (live-bet restore after a refresh). Deduplicated per slug inside a
// short staleness window so the two mounts cost ONE request.
import { http } from './api';
import { crashStateDto, type CrashState } from './dto';

const stateCache = new Map<string, { at: number; p: Promise<CrashState | null> }>();

export function fetchCrashState(slug: string): Promise<CrashState | null> {
  const hit = stateCache.get(slug);
  if (hit && Date.now() - hit.at < 1500) return hit.p;
  const p = http
    .get<CrashState>(`/games/${slug}/crash-state`, { schema: crashStateDto })
    .catch(() => null);
  stateCache.set(slug, { at: Date.now(), p });
  return p;
}
