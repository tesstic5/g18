// Ball/dot/badge colouring for the WinGo board.
//
// Real WinGo uses DUAL-colour balls for 0 and 5 (0 = red+violet,
// 5 = green+violet) — that detail is visible in the reference screenshots and
// easy to regress into a flat colour, so it is pinned here.
import { describe, expect, it } from 'vitest';
import { ballGradient, dotColor, sizeBadge, WG } from './wingo-theme';

describe('ballGradient', () => {
  it('renders 0 as a red/violet split ball', () => {
    const g = ballGradient(0);
    expect(g).toContain(WG.redBall);
    expect(g).toContain(WG.violet);
  });

  it('renders 5 as a green/violet split ball', () => {
    const g = ballGradient(5);
    expect(g).toContain(WG.green);
    expect(g).toContain(WG.violet);
  });

  it('renders odd digits green and even digits red', () => {
    for (const n of [1, 3, 7, 9]) expect(ballGradient(n)).toContain(WG.green);
    for (const n of [2, 4, 6, 8]) expect(ballGradient(n)).toContain(WG.redBall);
  });
});

describe('dotColor', () => {
  it('uses violet for the dual-colour digits', () => {
    expect(dotColor(0)).toBe(WG.violet);
    expect(dotColor(5)).toBe(WG.violet);
  });

  it('matches the standard WinGo colour rule for the rest', () => {
    expect(dotColor(1)).toBe(WG.green);
    expect(dotColor(2)).toBe(WG.redBall);
    expect(dotColor(9)).toBe(WG.green);
    expect(dotColor(8)).toBe(WG.redBall);
  });
});

describe('sizeBadge', () => {
  it('marks 5-9 as Big and 0-4 as Small', () => {
    for (const n of [5, 6, 7, 8, 9]) expect(sizeBadge(n).label).toBe('B');
    for (const n of [0, 1, 2, 3, 4]) expect(sizeBadge(n).label).toBe('S');
  });

  it('colours Big amber and Small blue', () => {
    expect(sizeBadge(7).color).toBe(WG.big);
    expect(sizeBadge(2).color).toBe(WG.small);
  });
});
