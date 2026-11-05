// packages/shared/src/utils/money.test.ts — decimal.js money math (docs/20 §4)
import { describe, expect, it } from 'vitest';
import { money, calculatePayout, calculateFee, isValidAmount } from './money';

describe('money', () => {
  it('never produces float artifacts', () => {
    expect(money(0.1).plus(0.2).toFixed(2)).toBe('0.30');
  });

  it('calculates payout with 2dp HALF_UP', () => {
    expect(calculatePayout('100', '1.9534').toFixed(2)).toBe('195.34');
    expect(calculatePayout('0.01', '3').toFixed(2)).toBe('0.03');
  });

  it('rounds fees UP (never down)', () => {
    expect(calculateFee('100', '2').toFixed(2)).toBe('2.00');
    expect(calculateFee('33.33', '2').toFixed(2)).toBe('0.67'); // 0.6666 → 0.67
    expect(calculateFee('1', '0.5').toFixed(2)).toBe('0.01'); // 0.005 → 0.01
  });

  it('validates amounts: positive, finite, max 2 decimals', () => {
    expect(isValidAmount(50)).toBe(true);
    expect(isValidAmount('50.25')).toBe(true);
    expect(isValidAmount(0)).toBe(false);
    expect(isValidAmount(-5)).toBe(false);
    expect(isValidAmount(50.123)).toBe(false);
    expect(isValidAmount('abc')).toBe(false);
    expect(isValidAmount(NaN)).toBe(false);
  });
});
