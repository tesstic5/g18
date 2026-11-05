// apps/api/src/routes/streak.test.ts — the daily-bonus streak must tell the truth.
//
// Reported bug: "claim bonus gets back to day one even after 2 days".
//
// The claim endpoint was right (miss a day, start again). The STATUS endpoint
// lied: it read `rows[0].streakCount` — the streak from the most recent
// check-in whenever that happened — so after missing days it still advertised
// "day N+1". The player claimed expecting day 2 and got day 1.
import { describe, it, expect } from 'vitest';
import { liveStreak } from './bonuses';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const row = (iso: string, streakCount: number) => ({ date: day(iso), streakCount });
const TODAY = day('2026-08-16');

describe('liveStreak', () => {
  it('is 0 with no history', () => {
    expect(liveStreak([], TODAY)).toBe(0);
  });

  it('counts a check-in made today', () => {
    expect(liveStreak([row('2026-08-16', 3)], TODAY)).toBe(3);
  });

  it('counts a check-in made yesterday — the run is still alive', () => {
    expect(liveStreak([row('2026-08-15', 4)], TODAY)).toBe(4);
  });

  it('DROPS to 0 when the last check-in was 2 days ago (the reported bug)', () => {
    // old code returned 5 here and promised "day 6"; claiming actually gave 1
    expect(liveStreak([row('2026-08-14', 5)], TODAY)).toBe(0);
  });

  it('drops to 0 after a long gap regardless of how high the streak got', () => {
    expect(liveStreak([row('2026-07-01', 30)], TODAY)).toBe(0);
  });

  it('agrees with what a claim will actually award', () => {
    // The claim rule: streak = (yesterday's streak ?? 0) + 1.
    const awardOnClaim = (rows: Array<{ date: Date; streakCount: number }>) => {
      const y = new Date(TODAY);
      y.setUTCDate(y.getUTCDate() - 1);
      const prev = rows.find((r) => r.date.getTime() === y.getTime());
      return (prev?.streakCount ?? 0) + 1;
    };
    for (const rows of [
      [] as Array<{ date: Date; streakCount: number }>,
      [row('2026-08-15', 4)],
      [row('2026-08-14', 5)],
      [row('2026-07-01', 30)],
    ]) {
      const shownNextDay = liveStreak(rows, TODAY) + 1;
      expect(shownNextDay, `rows: ${JSON.stringify(rows)}`).toBe(awardOnClaim(rows));
    }
  });

  it('uses the newest row when several exist', () => {
    const rows = [row('2026-08-15', 4), row('2026-08-14', 3), row('2026-08-13', 2)];
    expect(liveStreak(rows, TODAY)).toBe(4);
  });

  it('handles a month boundary', () => {
    expect(liveStreak([row('2026-07-31', 6)], day('2026-08-01'))).toBe(6);
    expect(liveStreak([row('2026-07-30', 6)], day('2026-08-01'))).toBe(0);
  });
});
