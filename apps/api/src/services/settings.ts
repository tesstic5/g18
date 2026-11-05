// apps/api/src/services/settings.ts — cached settings (Redis 30s TTL, docs/19 §13).
// D-081: FAIL-OPEN — Redis unavailability must not 500 every route; fall back to
// the DB directly (uncached) until Redis recovers.
import { DEFAULT_SETTINGS } from '@casino/shared/constants/limits';
import { prisma } from '../db/prisma';
import { redis, keys, logRedisIssue } from '../db/redis';

export async function getSettings(): Promise<Record<string, unknown>> {
  try {
    const cached = await redis.get(keys.settingsCache());
    if (cached) {
      const values = JSON.parse(cached) as Record<string, unknown>;
      delete values.payfast_private_v1;
      return values;
    }
  } catch (e) {
    logRedisIssue('settings', e);
  }
  const rows = await prisma.setting.findMany({ where: { key: { not: 'payfast_private_v1' } } });
  const merged = {
    ...DEFAULT_SETTINGS,
    ...Object.fromEntries(rows.map((r) => [r.key, r.value as unknown])),
  };
  try {
    await redis.set(keys.settingsCache(), JSON.stringify(merged), 'EX', 30);
  } catch {
    /* cache write best-effort */
  }
  return merged;
}

export async function getSetting<T>(key: string): Promise<T> {
  const s = await getSettings();
  return (s[key] ?? (DEFAULT_SETTINGS as Record<string, unknown>)[key]) as T;
}

/**
 * Read a setting that MUST be a usable positive number.
 *
 * `getSetting` returns whatever is in the JSON column, and `?? fallback` only
 * catches null/undefined. That is not enough for a limit:
 *
 *   stored 0        -> passes straight through. An admin who clears the
 *                      "max bet" field saves 0, and every bet on the platform
 *                      is then rejected with "Maximum bet for this game is Rs0".
 *                      Reproduced.
 *   stored "500000" -> a string; Decimal copes, plain arithmetic does not
 *   stored ""/"abc" -> `new Decimal("")` THROWS and 500s the bet endpoint
 *   stored -5       -> a negative limit is meaningless
 *
 * So a limit reader has to coerce, validate, and fall back to something sane
 * rather than trusting the column. `allowZero` exists for the settings where 0
 * is a legitimate value (a 0% fee, "feature off").
 */
export async function getNumericSetting(
  key: string,
  fallback: number,
  opts: { allowZero?: boolean; min?: number } = {}
): Promise<number> {
  let raw: unknown;
  try {
    raw = await getSetting<unknown>(key);
  } catch {
    return fallback; // settings unreachable — never take the platform down over it
  }
  const n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return fallback;
  if (n === 0 && !opts.allowZero) return fallback;
  if (opts.min != null && n < opts.min) return fallback;
  return n;
}

export async function setSetting(
  key: string,
  value: unknown,
  updatedBy?: string
): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: value as never, updatedBy },
    update: { value: value as never, updatedBy },
  });
  try {
    await redis.del(keys.settingsCache());
  } catch {
    /* best effort */
  }
}
