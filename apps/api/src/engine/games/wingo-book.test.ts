import { describe, expect, it } from 'vitest';
import {
  HARD_FADE_PROB,
  WINGO_PAYOUT,
  cheapestDigits,
  choiceHits,
  pickWingoNumber,
  uniformDigit,
  winningStakeByNumber,
  wingoMultiplier,
  DEFAULT_WINGO_PAYOUTS,
} from './wingo-book';

describe('flat 1.96× pay', () => {
  it('every bet type pays 2× minus 2%', () => {
    expect(WINGO_PAYOUT).toBe(1.96);
    for (const k of ['red', 'green', 'violet', 'number', 'big', 'small'] as const) {
      expect(DEFAULT_WINGO_PAYOUTS[k]).toBe(1.96);
    }
    expect(wingoMultiplier('red', DEFAULT_WINGO_PAYOUTS)).toBe(1.96);
    expect(wingoMultiplier(7, DEFAULT_WINGO_PAYOUTS)).toBe(1.96);
    expect(wingoMultiplier('bogus', DEFAULT_WINGO_PAYOUTS)).toBe(0);
  });
});

describe('choiceHits', () => {
  it('red / green / violet / big / small / number', () => {
    expect(choiceHits('red', 2)).toBe(true);
    expect(choiceHits('red', 1)).toBe(false);
    expect(choiceHits('green', 7)).toBe(true);
    expect(choiceHits('violet', 0)).toBe(true);
    expect(choiceHits('violet', 5)).toBe(true);
    expect(choiceHits('big', 5)).toBe(true);
    expect(choiceHits('small', 4)).toBe(true);
    expect(choiceHits(7, 7)).toBe(true);
    expect(choiceHits('7', 7)).toBe(true);
    expect(choiceHits('7', 8)).toBe(false);
  });
});

describe('winningStakeByNumber / cheapestDigits', () => {
  it('lone Red: cheapest digits are everything not red', () => {
    const s = winningStakeByNumber([{ choice: 'red', amount: 100 }]);
    expect(s[2]).toBe(100);
    expect(s[4]).toBe(100);
    expect(s[6]).toBe(100);
    expect(s[8]).toBe(100);
    expect(s[1]).toBe(0);
    expect(cheapestDigits(s)).toEqual([0, 1, 3, 5, 7, 9]);
  });

  it('heavy Red vs thin Green: cheapest is not-red', () => {
    const s = winningStakeByNumber([
      { choice: 'red', amount: 800 },
      { choice: 'green', amount: 200 },
    ]);
    const cheap = cheapestDigits(s);
    expect(cheap).toEqual([0, 5]); // violet only — neither red nor green
    expect(s[0]).toBe(0);
    expect(s[2]).toBe(800);
    expect(s[1]).toBe(200);
  });

  it('empty book: every digit equally cheap', () => {
    expect(cheapestDigits(winningStakeByNumber([]))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it('full cover still has a cheapest leftover (cannot zero everyone)', () => {
    const bets = [
      { choice: 'red', amount: 10 },
      { choice: 'green', amount: 10 },
      { choice: 'violet', amount: 10 },
      { choice: 'big', amount: 10 },
      { choice: 'small', amount: 10 },
      ...Array.from({ length: 10 }, (_, n) => ({ choice: n, amount: 1 })),
    ];
    const s = winningStakeByNumber(bets);
    expect(s.every((v) => v > 0)).toBe(true);
    expect(cheapestDigits(s).length).toBeGreaterThanOrEqual(1);
  });
});

describe('uniformDigit matches drawNumber on equal weights', () => {
  it('boundary 0.10 is digit 0 (not 1)', () => {
    expect(uniformDigit(0.1)).toBe(0);
    expect(uniformDigit(0.1000001)).toBe(1);
    expect(uniformDigit(0.25)).toBe(2);
    expect(uniformDigit(0.99)).toBe(9);
  });
});

describe('pickWingoNumber', () => {
  const redBook = winningStakeByNumber([{ choice: 'red', amount: 100 }]);

  it('easy / normal ignore the book (HMAC uniform from uGate)', () => {
    expect(
      pickWingoNumber({ level: 'normal', winningStake: redBook, uGate: 0.25, uPick: 0 })
    ).toBe(2);
    expect(
      pickWingoNumber({ level: 'easy', winningStake: redBook, uGate: 0.25, uPick: 0 })
    ).toBe(2);
    // 0.25 → digit 2 which IS red — they can still win on easy/normal
    expect(choiceHits('red', 2)).toBe(true);
  });

  it('impossible: lone Red always loses', () => {
    for (const u of [0.01, 0.2, 0.49, 0.73, 0.99]) {
      const n = pickWingoNumber({
        level: 'impossible',
        winningStake: redBook,
        uGate: u,
        uPick: u,
      });
      expect(choiceHits('red', n)).toBe(false);
    }
  });

  it('hard: fade when uGate < 0.8, random when uGate ≥ 0.8', () => {
    const fade = pickWingoNumber({
      level: 'hard',
      winningStake: redBook,
      uGate: HARD_FADE_PROB - 0.01,
      uPick: 0.0,
    });
    expect(choiceHits('red', fade)).toBe(false);
    const fair = pickWingoNumber({
      level: 'hard',
      winningStake: redBook,
      uGate: HARD_FADE_PROB,
      uPick: 0.25, // uniform digit 2 = red
    });
    expect(fair).toBe(2);
    expect(choiceHits('red', fair)).toBe(true);
  });

  it('impossible on empty book is uniform HMAC (no one to fade)', () => {
    const empty = winningStakeByNumber([]);
    expect(
      pickWingoNumber({
        level: 'impossible',
        winningStake: empty,
        uGate: 0.45,
        uPick: 0.45,
      })
    ).toBe(uniformDigit(0.45));
  });

  it('heavy Red loses on impossible (violet is cheapest)', () => {
    const s = winningStakeByNumber([
      { choice: 'red', amount: 800 },
      { choice: 'green', amount: 200 },
    ]);
    const n = pickWingoNumber({
      level: 'impossible',
      winningStake: s,
      uGate: 0.1,
      uPick: 0.0,
    });
    expect([0, 5]).toContain(n);
  });
});
