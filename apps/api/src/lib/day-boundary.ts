// apps/api/src/lib/day-boundary.ts — ONE definition of "today" for the platform.
//
// Day boundaries used to be computed inline as `start.setUTCHours(0, 0, 0, 0)`
// in eight different files (responsible-play limits, deposit limits, dashboard
// stats, reports, leaderboards, rakeback). That is a UTC midnight boundary: for
// a Pakistan-facing operator (UTC+5) the "daily" loss and deposit limits rolled
// over at 05:00 in the morning, in the middle of the playing evening.
//
// The default is STILL UTC: silently moving money-limit boundaries on deploy is
// more dangerous than keeping the historical behaviour. Set PLATFORM_TZ to an
// IANA zone (e.g. `Asia/Karachi`) to align every day/week boundary — limits,
// stats, reports, leaderboards and rakeback — with the operator's local day in
// one place.

const FALLBACK_TZ = 'UTC';

let cachedTz: string | null = null;

/** Validate an IANA time zone name without throwing. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The platform time zone. Cached because it is read on essentially every bet
 * (the responsible-play guard) and `Intl` construction is not free.
 */
export function platformTimeZone(): string {
  if (cachedTz) return cachedTz;
  const raw = (process.env.PLATFORM_TZ ?? '').trim();
  if (!raw) {
    cachedTz = FALLBACK_TZ;
  } else if (isValidTimeZone(raw)) {
    cachedTz = raw;
  } else {
    cachedTz = FALLBACK_TZ;
    console.warn(
      `[day-boundary] PLATFORM_TZ="${raw}" is not a valid IANA time zone — falling back to ${FALLBACK_TZ}.`
    );
  }
  return cachedTz;
}

/** Offset of `tz` from UTC at the given instant, in milliseconds. */
function offsetMs(at: Date, tz: string): number {
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
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  // Some ICU builds format midnight as hour "24".
  const hour = get('hour') === 24 ? 0 : get('hour');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second')
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Midnight that starts the day containing `at`, in the platform time zone. */
/**
 * Convert a wall-clock time (ms, interpreted as if it were UTC) in `tz` back
 * to the real UTC instant that shows that wall clock.
 *
 * The offset itself depends on the instant we are trying to find, and it can
 * change between the two ends of a DST transition — so iterate until the
 * answer stops moving (it converges in 1 step outside a transition, 2 inside).
 */
function utcFromWall(wallMs: number, tz: string): number {
  let guess = wallMs - offsetMs(new Date(wallMs), tz);
  for (let i = 0; i < 3; i++) {
    const next = wallMs - offsetMs(new Date(guess), tz);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

export function startOfDay(
  at: Date = new Date(),
  tz: string = platformTimeZone()
): Date {
  const wallMs = at.getTime() + offsetMs(at, tz);
  const dayWall = Math.floor(wallMs / 86_400_000) * 86_400_000;
  return new Date(utcFromWall(dayWall, tz));
}

/** Midnight that starts the MONDAY of the week containing `at`. */
export function startOfWeek(
  at: Date = new Date(),
  tz: string = platformTimeZone()
): Date {
  const wallMs = at.getTime() + offsetMs(at, tz);
  const dayWall = Math.floor(wallMs / 86_400_000) * 86_400_000;
  const dow = (new Date(dayWall).getUTCDay() + 6) % 7; // 0 = Monday
  return new Date(utcFromWall(dayWall - dow * 86_400_000, tz));
}

/** Calendar day key in the platform time zone, e.g. "2026-08-31". */
export function dayKey(at: Date = new Date(), tz: string = platformTimeZone()): string {
  const wall = new Date(at.getTime() + offsetMs(at, tz));
  const y = wall.getUTCFullYear();
  const m = String(wall.getUTCMonth() + 1).padStart(2, '0');
  const d = String(wall.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Add whole calendar days (kept separate from DST-sensitive date arithmetic). */
export function addDays(
  date: Date,
  days: number,
  tz: string = platformTimeZone()
): Date {
  // Calendar days, not 24-hour blocks: on a DST transition day the local day
  // is 23 or 25 hours long, and naive +24h would drift the wall-clock time.
  const wallMs = date.getTime() + offsetMs(date, tz);
  return new Date(utcFromWall(wallMs + days * 86_400_000, tz));
}
