// apps/web/src/components/games/individual/wingo-core.test.ts — WinGo rules (D-106)
import { describe, expect, it } from 'vitest';
import {
  COLOR_OF,
  DIGIT_COLORS,
  PAYOUTS,
  choiceWins,
  choiceMultiplier,
  QUANTITIES,
  QUICK_AMOUNTS,
  DURATIONS,
  durationLabel,
  clampDuration,
  computeWingoStats,
} from './wingo-core';

describe('wingo-core (D-106 real WinGo rules)', () => {
  it('maps digits to the real WinGo colors: green 1,3,7,9 · red 2,4,6,8 · violet 0,5', () => {
    expect([1, 3, 7, 9].map(COLOR_OF)).toEqual(['green', 'green', 'green', 'green']);
    expect([2, 4, 6, 8].map(COLOR_OF)).toEqual(['red', 'red', 'red', 'red']);
    expect(COLOR_OF(0)).toBe('violet');
    expect(COLOR_OF(5)).toBe('violet');
  });

  it('digit row colors follow the mapping', () => {
    expect(DIGIT_COLORS).toHaveLength(10);
    expect(DIGIT_COLORS[1]).toBe('#00d97e'); // 1 → green
    expect(DIGIT_COLORS[4]).toBe('#ff3b5c'); // 4 → red
    expect(DIGIT_COLORS[5]).toBe('#9b59ff'); // 5 → violet
  });

  it('choiceWins: color / number / big / small', () => {
    expect(choiceWins('green', 7)).toBe(true);
    expect(choiceWins('green', 2)).toBe(false);
    expect(choiceWins('red', 8)).toBe(true);
    expect(choiceWins('violet', 0)).toBe(true);
    expect(choiceWins('violet', 5)).toBe(true);
    expect(choiceWins(9, 9)).toBe(true);
    expect(choiceWins(9, 8)).toBe(false);
    expect(choiceWins('big', 5)).toBe(true);
    expect(choiceWins('big', 4)).toBe(false);
    expect(choiceWins('small', 4)).toBe(true);
    expect(choiceWins('small', 5)).toBe(false);
    expect(choiceWins(null, 3)).toBe(false);
  });

  it('every winning ticket pays 1.96×', () => {
    expect(PAYOUTS.red).toBe(1.96);
    expect(PAYOUTS.green).toBe(1.96);
    expect(PAYOUTS.violet).toBe(1.96);
    expect(PAYOUTS.number).toBe(1.96);
    expect(PAYOUTS.big).toBe(1.96);
    expect(PAYOUTS.small).toBe(1.96);
    expect(choiceMultiplier(7)).toBe(1.96);
    expect(choiceMultiplier('green')).toBe(1.96);
    expect(choiceMultiplier(null)).toBeNull();
  });

  it('quantity & quick-amount chips match the reference popup', () => {
    expect(QUANTITIES).toEqual([1, 5, 10, 20, 50, 100]);
    expect(QUICK_AMOUNTS).toEqual([10, 100, 1000]);
  });

  it('D-107: four lottery times run — 30s / 1min / 3min / 5min', () => {
    expect(DURATIONS).toEqual([30, 60, 180, 300]);
    expect(durationLabel(30)).toBe('30 Sec');
    expect(durationLabel(60)).toBe('1 Min');
    expect(durationLabel(180)).toBe('3 Min');
    expect(durationLabel(300)).toBe('5 Min');
    expect(clampDuration(60)).toBe(60);
    expect(clampDuration(180)).toBe(180);
    expect(clampDuration(300)).toBe(300);
    expect(clampDuration(undefined)).toBe(30);
    expect(clampDuration(45)).toBe(30); // unknown → default 30s
  });

  it('D-108: statistics — frequency / missing / avg missing / max consecutive', () => {
    // 10 rounds: 7,7,7, 0, 7, 7, 3, 3, 3, 7
    const history = [
      { number: 7 },
      { number: 7 },
      { number: 7 },
      { number: 0 },
      { number: 7 },
      { number: 7 },
      { number: 3 },
      { number: 3 },
      { number: 3 },
      { number: 7 },
    ];
    const s = computeWingoStats(history);
    expect(s.frequency[7]).toBe(6); // 7 appears 6× (idx 0,1,2,4,5,9)
    expect(s.frequency[3]).toBe(3);
    expect(s.frequency[0]).toBe(1);
    expect(s.frequency[1]).toBe(0);
    expect(s.missing[7]).toBe(0); // last round was 7
    expect(s.missing[3]).toBe(1); // 3 appeared 1 round ago
    expect(s.missing[0]).toBe(6); // 0 appeared 6 rounds ago
    expect(s.missing[1]).toBe(10); // never appeared
    expect(s.maxConsecutive[7]).toBe(3); // run of 7,7,7
    expect(s.maxConsecutive[3]).toBe(3); // run of 3,3,3
    expect(s.maxConsecutive[0]).toBe(1);
    expect(s.maxConsecutive[1]).toBe(0);
    // avg missing for 7: gaps [1,2,2,2] → (1+2+2+2)/4 ≈ 2
    expect(s.avgMissing[7]).toBe(2);
    // long window (120 rounds) only counts the last 100
    const long = Array.from({ length: 120 }, (_, i) => ({ number: i % 10 }));
    const s2 = computeWingoStats(long);
    expect(s2.frequency.reduce((a, b) => a + b, 0)).toBe(100);
  });
});

// ── v1.3.6 regression lock: the chart must NEVER change direction depending
// on which fetch lands second. Newest period at the top, always. ──

import { trendRowsFor, lastResultsFor } from './wingo-core';

describe('trendRowsFor / lastResultsFor (v1.3.6 chart ordering)', () => {
  const mk = (n: number) => ({
    period: `P${String(n).padStart(3, '0')}`,
    number: n % 10,
  });
  // chronological server seed (oldest → newest) for periods 1..50
  const recentTail = Array.from({ length: 50 }, (_, i) => mk(i + 1));
  // paginated page-1 rows arrive newest-first (50..41)
  const page1 = [...recentTail].slice(-10).reverse();

  it('fallback (seed only): newest period on top', () => {
    const rows = trendRowsFor([], recentTail);
    expect(rows[0]!.period).toBe('P050');
    expect(rows[9]!.period).toBe('P041');
  });

  it('list rows (already newest-first): used unchanged, newest on top', () => {
    const rows = trendRowsFor(page1, recentTail);
    expect(rows).toBe(page1); // no re-ordering of the server order
    expect(rows[0]!.period).toBe('P050');
    expect(rows[9]!.period).toBe('P041');
  });

  it('race-lock: fallback and hydrated views show the SAME order (no flip)', () => {
    const before = trendRowsFor([], recentTail).map((r) => r.period);
    const after = trendRowsFor(page1, recentTail).map((r) => r.period);
    expect(after).toEqual(before);
  });

  it('live prepend keeps newest on top', () => {
    const live = [mk(51), ...page1].slice(0, 10);
    expect(trendRowsFor(live, recentTail)[0]!.period).toBe('P051');
  });

  it('banner last-5 strip: newest always leftmost, matching the grid top', () => {
    const strip = lastResultsFor(recentTail).map((r) => r.period);
    expect(strip).toEqual(['P050', 'P049', 'P048', 'P047', 'P046']);
    const gridTop = trendRowsFor(page1, recentTail)
      .map((r) => r.period)
      .slice(0, 5);
    expect(strip).toEqual(gridTop);
  });
});
