// Every day/week boundary in the platform (responsible-play limits, deposit
// limits, dashboard + report buckets, leaderboards, rakeback) flows through
// this module, so the arithmetic gets tested directly — including DST
// transitions, which is where naive offset maths silently breaks.

import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayKey,
  isValidTimeZone,
  platformTimeZone,
  startOfDay,
  startOfWeek,
} from './day-boundary';

const ZONES = [
  'UTC',
  'Asia/Karachi', // UTC+5, no DST — the operator's likely zone
  'America/New_York', // DST, spring forward 2026-03-08
  'Europe/London', // DST, different transition date
  'Australia/Lord_Howe', // 30-minute DST shift
  'Pacific/Kiritimati', // UTC+14, other side of the date line
];

// Instants worth checking per zone: plain days, both DST transition days, and
// the ambiguous/duplicate hour.
const INSTANTS = [
  '2026-08-31T20:30:00Z',
  '2026-01-01T00:00:00Z',
  '2026-12-31T23:59:59Z',
  '2026-03-08T04:00:00Z', // just before US spring forward
  '2026-03-08T08:00:00Z', // just after US spring forward
  '2026-11-01T05:30:00Z', // inside the ambiguous US hour
  '2026-11-01T07:00:00Z', // after US fall back
  '2026-10-04T00:30:00Z', // Lord Howe 30-min spring forward
];

describe('platformTimeZone', () => {
  it('defaults to UTC when PLATFORM_TZ is unset', () => {
    expect(platformTimeZone()).toBe('UTC');
  });

  it('rejects zones that are not IANA names', () => {
    expect(isValidTimeZone('Asia/Karachi')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('day boundaries', () => {
  for (const tz of ZONES) {
    for (const iso of INSTANTS) {
      const at = new Date(iso);

      it(`startOfDay is the midnight at or before ${iso} in ${tz}`, () => {
        const sod = startOfDay(at, tz);
        expect(sod.getTime()).toBeLessThanOrEqual(at.getTime());
        // Less than one local day behind.
        expect(at.getTime() - sod.getTime()).toBeLessThan(27 * 3_600_000);
        // The day it starts is the day the instant falls in.
        expect(dayKey(sod, tz)).toBe(dayKey(at, tz));
        // Its wall clock is midnight: 00:00:00.000 local.
        const wall = new Date(sod.getTime() + localOffset(sod, tz));
        expect(wall.getUTCHours()).toBe(0);
        expect(wall.getUTCMinutes()).toBe(0);
        expect(wall.getUTCSeconds()).toBe(0);
        expect(wall.getUTCMilliseconds()).toBe(0);
        // Idempotent — starting the day of a start-of-day is itself.
        expect(startOfDay(sod, tz).getTime()).toBe(sod.getTime());
      });

      it(`startOfWeek is a Monday at or before ${iso} in ${tz}`, () => {
        const sow = startOfWeek(at, tz);
        expect(sow.getTime()).toBeLessThanOrEqual(at.getTime());
        expect(at.getTime() - sow.getTime()).toBeLessThan(8 * 86_400_000);
        const wall = new Date(sow.getTime() + localOffset(sow, tz));
        expect(wall.getUTCDay()).toBe(1); // Monday
        expect(wall.getUTCHours()).toBe(0);
        expect(startOfWeek(sow, tz).getTime()).toBe(sow.getTime());
      });

      it(`addDays walks whole local days in ${tz} at ${iso}`, () => {
        const sod = startOfDay(at, tz);
        const next = addDays(sod, 1, tz);
        const wall = new Date(next.getTime() + localOffset(next, tz));
        // Still local midnight, and exactly one calendar day later. The oracle
        // is wall-clock date arithmetic, NOT `+24h`: on a DST transition day
        // the local day is 23 or 25 hours long.
        expect(wall.getUTCHours()).toBe(0);
        const [y, m, d] = wallYmd(sod, tz);
        expect(dayKey(next, tz)).toBe(ymdKey(Date.UTC(y, m - 1, d + 1)));
        expect(addDays(sod, -1, tz).getTime()).toBeLessThan(sod.getTime());
        expect(addDays(sod, 0, tz).getTime()).toBe(sod.getTime());
        // A local day is 24h except across a DST transition, where the shift
        // is usually an hour but is 30 minutes on Lord Howe Island.
        const lenHours = (next.getTime() - sod.getTime()) / 3_600_000;
        expect(lenHours).toBeGreaterThanOrEqual(23);
        expect(lenHours).toBeLessThanOrEqual(25);
      });
    }
  }

  it('keeps the local day length right across a DST transition', () => {
    // US spring forward: 2026-03-08 is a 23-hour day in New York.
    const spring = startOfDay(new Date('2026-03-08T12:00:00Z'), 'America/New_York');
    expect(addDays(spring, 1, 'America/New_York').getTime() - spring.getTime()).toBe(
      23 * 3_600_000
    );
    // US fall back: 2026-11-01 is a 25-hour day.
    const fall = startOfDay(new Date('2026-11-01T12:00:00Z'), 'America/New_York');
    expect(addDays(fall, 1, 'America/New_York').getTime() - fall.getTime()).toBe(
      25 * 3_600_000
    );
    // ...and both still land on local midnight of the following day.
    for (const sod of [spring, fall]) {
      const next = addDays(sod, 1, 'America/New_York');
      const wall = new Date(next.getTime() + localOffset(next, 'America/New_York'));
      expect(wall.getUTCHours()).toBe(0);
      expect(dayKey(next, 'America/New_York')).toBe(
        ymdKey(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()))
      );
    }
  });

  it('matches the historical UTC behaviour that it replaces', () => {
    // The old inline code was: const start = new Date(); start.setUTCHours(0,0,0,0)
    const at = new Date('2026-08-31T20:30:00Z');
    const legacy = new Date(at);
    legacy.setUTCHours(0, 0, 0, 0);
    expect(startOfDay(at, 'UTC').getTime()).toBe(legacy.getTime());
    expect(dayKey(at, 'UTC')).toBe('2026-08-31');
  });

  it('moves the boundary with the zone, which is the whole point', () => {
    // 20:30 UTC is already the next calendar day in Karachi (UTC+5).
    const at = new Date('2026-08-31T20:30:00Z');
    expect(dayKey(at, 'UTC')).toBe('2026-08-31');
    expect(dayKey(at, 'Asia/Karachi')).toBe('2026-09-01');
    expect(startOfDay(at, 'Asia/Karachi').toISOString()).toBe(
      '2026-08-31T19:00:00.000Z'
    );
  });
});

/** Wall-clock Y/M/D of an instant in `tz`, straight from Intl. */
function wallYmd(at: Date, tz: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  const seg = parts.split('-');
  return [Number(seg[0]), Number(seg[1]), Number(seg[2])];
}

function ymdKey(utcMs: number): string {
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate()
  ).padStart(2, '0')}`;
}

/** Independent offset lookup, so the test is not just trusting offsetMs(). */
function localOffset(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second')
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}
