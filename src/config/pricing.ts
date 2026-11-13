import Decimal from 'decimal.js';
import { Types } from 'mongoose';
import { badRequest } from '../common/errors';
import { dec } from '../common/utils/money';

/** Added per night for each guest beyond two. */
export const EXTRA_GUEST_CHARGE = '300';
export const MIN_GUESTS = 1;
export const MAX_GUESTS = 4;

export interface PricedRoom {
  rate: Types.Decimal128;
  singleRate?: Types.Decimal128 | null;
  doubleRate?: Types.Decimal128 | null;
}

/** Rooms created before per-guest pricing have only `rate`; it stands in for both. */
export const singleRateOf = (room: PricedRoom) => dec(room.singleRate ?? room.rate);
export const doubleRateOf = (room: PricedRoom) => dec(room.doubleRate ?? room.singleRate ?? room.rate);

/**
 * The nightly rate for a room and guest count. The server's figure always
 * wins; a rate sent by an app is ignored.
 *   1 guest   → single rate
 *   2 guests  → double rate
 *   3–4       → double rate + 300 per guest above two
 */
export function nightlyRate(room: PricedRoom, guests: number): Decimal {
  if (!Number.isInteger(guests) || guests < MIN_GUESTS || guests > MAX_GUESTS) {
    throw badRequest('INVALID_GUESTS', `Guests must be between ${MIN_GUESTS} and ${MAX_GUESTS}`);
  }
  if (guests === 1) return singleRateOf(room);
  return doubleRateOf(room).plus(dec(EXTRA_GUEST_CHARGE).times(guests - 2));
}
