// apps/web/src/components/games/individual/wingo-core.ts — pure WinGo rules (D-106).
// No React/socket imports — unit-testable in isolation.
// Real WinGo mapping: GREEN = 1,3,7,9 · RED = 2,4,6,8 · VIOLET = 0,5
// BIG = 5-9 · SMALL = 0-4 · every winning ticket pays 1.96×.
export const COLOR_OF = (n: number): 'green' | 'red' | 'violet' =>
  n === 0 || n === 5 ? 'violet' : n % 2 === 1 ? 'green' : 'red';

export const COLOR_HEX: Record<string, string> = {
  red: '#ff3b5c',
  green: '#00d97e',
  violet: '#9b59ff',
};
export const DIGIT_COLORS = Array.from(
  { length: 10 },
  (_, n) => COLOR_HEX[COLOR_OF(n)]
);
export const PAYOUTS: Record<string, number> = {
  red: 1.96,
  green: 1.96,
  violet: 1.96,
  number: 1.96,
  big: 1.96,
  small: 1.96,
};
export const QUANTITIES = [1, 5, 10, 20, 50, 100];
export const QUICK_AMOUNTS = [10, 100, 1000];
export const COLOR_OPTIONS = ['green', 'violet', 'red'] as const;

/** D-107: the four lottery times — 30s / 1min / 3min / 5min */
export const DURATIONS = [30, 60, 180, 300] as const;
export type WingoDuration = (typeof DURATIONS)[number];

export function durationLabel(d: WingoDuration): string {
  if (d === 60) return '1 Min';
  if (d === 180) return '3 Min';
  if (d === 300) return '5 Min';
  return '30 Sec';
}

export function clampDuration(d: number | undefined | null): WingoDuration {
  if (d === 60 || d === 180 || d === 300) return d;
  return 30;
}

// ── D-108: statistics over the round history (reference "Statistic (last 100
//    Periods)" panel) ──────────────────────────────────────────────────────
export interface WingoStats {
  /** how many times each digit appeared in the last 100 rounds */
  frequency: number[];
  /** periods since each digit last appeared (gap; 100+ if never in window) */
  missing: number[];
  /** average gap between appearances (last 100) */
  avgMissing: number[];
  /** longest consecutive-run of appearances (last 100) */
  maxConsecutive: number[];
  /** last-100 counts (same as frequency) — displayed under Winning Numbers */
  counts: number[];
}

/**
 * Trend-grid row order — v1.3.6. NEWEST period at the top, for BOTH data
 * sources the grid is fed from:
 *  - the paginated /history-list page arrives newest-first → used as-is;
 *  - the /recent seed (the pre-fetch fallback) is chronological, so it is
 *    reversed here.
 * The bug this locks: the two paths used to disagree about direction, so
 * whichever fetch resolved second visibly REORDERED the grid on every reload
 * ("the chart changes every time"). One direction, always, no flip.
 */
export function trendRowsFor<T>(listRows: T[], recentSeed: T[], limit = 10): T[] {
  if (listRows.length) return listRows;
  return recentSeed.slice(-limit).reverse();
}

/** Last-N strip (the red banner balls): newest result FIRST, matching the
 *  grid's top row. `recentSeed` is chronological (oldest→newest). */
export function lastResultsFor<T>(recentSeed: T[], n = 5): T[] {
  return recentSeed.slice(-n).reverse();
}

export function computeWingoStats(history: Array<{ number: number }>): WingoStats {
  const last100 = history.slice(-100);
  const freq = Array.from({ length: 10 }, () => 0);
  for (const h of last100)
    if (h.number >= 0 && h.number <= 9) freq[h.number] = (freq[h.number] ?? 0) + 1;

  const missing = Array.from({ length: 10 }, () => 0);
  const avgMissing = Array.from({ length: 10 }, () => 0);
  const maxConsecutive = Array.from({ length: 10 }, () => 0);
  for (let d = 0; d < 10; d++) {
    // gaps between consecutive appearances (and from the start of the window)
    const gaps: number[] = [];
    let run = 0;
    let lastIdx = -1;
    for (let i = 0; i < last100.length; i++) {
      if (last100[i]!.number === d) {
        gaps.push(i - lastIdx); // periods since previous appearance (or since window start)
        lastIdx = i;
        run++;
        if (run > maxConsecutive[d]!) maxConsecutive[d] = run;
      } else {
        run = 0;
      }
    }
    if (lastIdx === -1) {
      missing[d] = last100.length; // never appeared in the window
      avgMissing[d] = 0;
    } else {
      missing[d] = last100.length - 1 - lastIdx; // periods since last appearance
      avgMissing[d] = gaps.length
        ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
        : 0;
    }
  }
  return { frequency: freq, missing, avgMissing, maxConsecutive, counts: freq };
}

/** wins on: color matches digit color, exact number, or big/small group */
export function choiceWins(
  choice: string | number | null | undefined,
  number: number
): boolean {
  if (choice === null || choice === undefined) return false;
  if (typeof choice === 'number') return choice === number;
  if (choice === 'big') return number >= 5;
  if (choice === 'small') return number <= 4;
  return choice === COLOR_OF(number);
}

export function choiceMultiplier(
  choice: string | number | null | undefined
): number | null {
  if (choice === null || choice === undefined) return null;
  return typeof choice === 'number'
    ? (PAYOUTS.number ?? null)
    : (PAYOUTS[choice] ?? null);
}
