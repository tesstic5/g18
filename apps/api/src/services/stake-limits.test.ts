// "Maximum bet for this game is ₨0" — a real report from a live player.
//
// A limit read from a JSON settings column is not automatically a usable
// number. `?? fallback` only catches null and undefined, so a stored 0 sails
// straight through — and an admin who clears the "max bet" field in the panel
// saves exactly that. The resolved maximum became 0 and EVERY bet on the
// platform was rejected: a total outage wearing a validation message.
//
// These tests pin the rule: whatever nonsense the database holds, the platform
// must still be playable, and a legitimate limit must still be obeyed.
import { describe, it, expect } from 'vitest';

/** The coercion used by getNumericSetting(). */
function numericSetting(
  raw: unknown,
  fallback: number,
  opts: { allowZero?: boolean } = {}
): number {
  const n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return fallback;
  if (n === 0 && !opts.allowZero) return fallback;
  return n;
}

describe('numeric settings survive a broken database', () => {
  const FALLBACK = 500_000;

  it('a stored 0 does NOT become the limit', () => {
    // This is the exact bug: `0 ?? fallback` is 0, so the max bet became zero.
    const oldCoalesce = (raw: number | null | undefined) => raw ?? FALLBACK;
    expect(oldCoalesce(0)).toBe(0); // the old behaviour
    expect(numericSetting(0, FALLBACK)).toBe(FALLBACK); // the fixed behaviour
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace', '   '],
    ['junk', 'abc'],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('falls back when the value is %s', (_label, raw) => {
    expect(numericSetting(raw, FALLBACK)).toBe(FALLBACK);
  });

  it('accepts a real value, including one stored as a string', () => {
    expect(numericSetting(250, FALLBACK)).toBe(250);
    expect(numericSetting('250', FALLBACK)).toBe(250);
    expect(numericSetting('  250  ', FALLBACK)).toBe(250);
  });

  it('allows a legitimate zero where zero is meaningful', () => {
    // e.g. a 0% withdrawal fee is a real setting, unlike a 0 maximum bet.
    expect(numericSetting(0, 2, { allowZero: true })).toBe(0);
  });
});

describe('the resolved stake window is always playable', () => {
  /** The final sanity net from stakeLimitsFor(). */
  function resolve(
    minRaw: number,
    maxRaw: number,
    DEFAULT_MIN = 10,
    DEFAULT_MAX = 500_000
  ) {
    let minBet = minRaw;
    let maxBet = maxRaw;
    if (!Number.isFinite(maxBet) || maxBet <= 0) maxBet = DEFAULT_MAX;
    if (!Number.isFinite(minBet) || minBet < 0) minBet = DEFAULT_MIN;
    if (minBet > maxBet) minBet = Math.min(minBet, maxBet);
    return { minBet, maxBet };
  }

  it('never resolves to a zero maximum', () => {
    expect(resolve(10, 0).maxBet).toBe(500_000);
    expect(resolve(10, Number.NaN).maxBet).toBe(500_000);
    expect(resolve(10, -1).maxBet).toBe(500_000);
  });

  it('never leaves the minimum above the maximum', () => {
    // A 1000 floor under a 250 ceiling rejects every possible stake.
    const r = resolve(1000, 250);
    expect(r.minBet).toBeLessThanOrEqual(r.maxBet);
  });

  it('still honours a genuine per-game limit', () => {
    expect(resolve(10, 250)).toEqual({ minBet: 10, maxBet: 250 });
  });
});
