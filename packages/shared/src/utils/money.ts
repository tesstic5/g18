// packages/shared/src/utils/money.ts — decimal.js everywhere (docs/20 §4 canonical)
import Decimal from 'decimal.js';

Decimal.set({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
  toExpPos: 9999,
  toExpNeg: -9999,
});

export { Decimal };

export function money(value: number | string | Decimal): Decimal {
  return new Decimal(value);
}

/** Payout = bet × multiplier, rounded to 2dp (HALF_UP). */
export function calculatePayout(
  betAmount: number | string | Decimal,
  multiplier: number | string | Decimal
): Decimal {
  return money(betAmount).mul(money(multiplier)).toDecimalPlaces(2);
}

/** Fee always rounds UP (never short-change the house; never surprise the player with a bigger fee). */
export function calculateFee(
  amount: number | string | Decimal,
  feePercent: number | string | Decimal
): Decimal {
  return money(amount)
    .mul(money(feePercent))
    .div(100)
    .toDecimalPlaces(2, Decimal.ROUND_UP);
}

export function formatMoney(value: number | string | Decimal, decimals = 2): string {
  return money(value).toFixed(decimals);
}

/** Prisma Decimal fields accept string. */
export function toDbDecimal(value: Decimal): string {
  return value.toFixed(2);
}

/** Validate an amount: positive, finite, max 2 decimals (docs/14 VALIDATION). */
export function isValidAmount(value: unknown): value is number | string {
  try {
    const d = new Decimal(String(value));
    return d.isFinite() && d.gt(0) && d.decimalPlaces() <= 2;
  } catch {
    return false;
  }
}
