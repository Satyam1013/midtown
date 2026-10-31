import Decimal from 'decimal.js';
import { Types } from 'mongoose';

// All money is held as Decimal128 in MongoDB and as decimal.js Decimal in
// memory. JS numbers are only ever produced at the JSON boundary, for
// display, after all arithmetic is done.

Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP });

export type MoneyInput = Decimal | Types.Decimal128 | string | number;

export const MONEY_SCALE = 2;

export function dec(value: MoneyInput | null | undefined): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  if (value instanceof Decimal) return value;
  if (value instanceof Types.Decimal128) return new Decimal(value.toString());
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`Not a finite amount: ${value}`);
  }
  return new Decimal(value);
}

/** Round to paise and convert for storage. */
export function toD128(value: MoneyInput): Types.Decimal128 {
  return Types.Decimal128.fromString(dec(value).toFixed(MONEY_SCALE));
}

/** Same as toD128 but without forcing two decimal places (stock quantities, percentages). */
export function toD128Exact(value: MoneyInput): Types.Decimal128 {
  return Types.Decimal128.fromString(dec(value).toString());
}

/** Percentage of an amount, rounded to paise. */
export function pct(amount: MoneyInput, percent: MoneyInput): Decimal {
  return dec(amount).times(dec(percent)).dividedBy(100).toDecimalPlaces(MONEY_SCALE);
}

export function sum(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));
}
