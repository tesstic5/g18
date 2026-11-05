// apps/api/src/engine/games/wingo-rounds.test.ts — four lottery times + bet lock
import { describe, expect, it } from 'vitest';
import {
  WINGO_DURATIONS,
  WINGO_LOCK_SEC,
  durationKey,
  nextPeriod,
  DEFAULT_WINGO_PAYOUTS,
  wingoMultiplier,
} from './WingoRoundManager';

describe('wingo round times (D-107)', () => {
  it('runs four lottery times: 30s / 1min / 3min / 5min', () => {
    expect(WINGO_DURATIONS).toEqual([30, 60, 180, 300]);
    expect(durationKey(30)).toBe('30s');
    expect(durationKey(60)).toBe('60s');
    expect(durationKey(180)).toBe('180s');
    expect(durationKey(300)).toBe('300s');
  });

  it('bet lock is exactly 5 seconds', () => {
    expect(WINGO_LOCK_SEC).toBe(5);
  });

  it('periods are unique daily 17-digit numbers (date + 9-digit sequence)', async () => {
    const p = await nextPeriod(Date.UTC(2026, 7, 15, 10, 0, 0));
    expect(p).toMatch(/^20260815\d{9}$/);
    expect(p.length).toBe(17);
    const p2 = await nextPeriod(Date.UTC(2026, 7, 15, 10, 0, 5));
    expect(p2).not.toBe(p); // sequence increments
  });

  it('every winning ticket pays 1.96×', () => {
    expect(DEFAULT_WINGO_PAYOUTS.red).toBe(1.96);
    expect(DEFAULT_WINGO_PAYOUTS.green).toBe(1.96);
    expect(DEFAULT_WINGO_PAYOUTS.violet).toBe(1.96);
    expect(DEFAULT_WINGO_PAYOUTS.number).toBe(1.96);
    expect(DEFAULT_WINGO_PAYOUTS.big).toBe(1.96);
    expect(DEFAULT_WINGO_PAYOUTS.small).toBe(1.96);
    expect(wingoMultiplier('big', DEFAULT_WINGO_PAYOUTS)).toBe(1.96);
    expect(wingoMultiplier(7, DEFAULT_WINGO_PAYOUTS)).toBe(1.96);
    expect(wingoMultiplier('bogus', DEFAULT_WINGO_PAYOUTS)).toBe(0);
  });
});
