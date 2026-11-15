import Decimal from 'decimal.js';
import { Types } from 'mongoose';
import { badRequest } from '../common/errors';
import { dec } from '../common/utils/money';

/** Hotel default, per night for each guest beyond two, when a room sets no additionalGuestPrice. */
export const EXTRA_GUEST_CHARGE = '300';
export const MIN_GUESTS = 1;
/** Hard ceiling for any room (a room's `sleeps` goes up to this). */
export const MAX_GUESTS = 10;
/** Limit for a room that doesn't set `sleeps`, as before. */
export const DEFAULT_ROOM_GUESTS = 4;

export interface PricedRoom {
  rate: Types.Decimal128;
  singleRate?: Types.Decimal128 | null;
  doubleRate?: Types.Decimal128 | null;
  additionalGuestPrice?: Types.Decimal128 | null;
  sleeps?: number | null;
  number?: string;
}

/** Most guests a room takes: its `sleeps`, else the old limit of 4. */
export const roomCapacity = (room: PricedRoom) => room.sleeps ?? DEFAULT_ROOM_GUESTS;

/** Rejects more guests than the room sleeps, naming the room. */
export function assertFits(room: PricedRoom, guests: number) {
  const max = roomCapacity(room);
  if (guests > max) {
    throw badRequest('TOO_MANY_GUESTS', `Room ${room.number ?? ''} sleeps at most ${max} guest${max === 1 ? '' : 's'}`.replace('Room  ', 'This room '));
  }
}

/** Rooms created before per-guest pricing have only `rate`; it stands in for both. */
export const singleRateOf = (room: PricedRoom) => dec(room.singleRate ?? room.rate);
export const doubleRateOf = (room: PricedRoom) => dec(room.doubleRate ?? room.singleRate ?? room.rate);

/**
 * The nightly rate for a room and guest count. The server's figure always
 * wins; a rate sent by an app is ignored.
 *   1 guest   → single rate
 *   2 guests  → double rate
 *   3+        → double rate + extra charge per guest above two, where the
 *               extra charge is the room's additionalGuestPrice, else ₹300
 * More guests than the room sleeps is refused.
 */
export function nightlyRate(room: PricedRoom, guests: number): Decimal {
  if (!Number.isInteger(guests) || guests < MIN_GUESTS) throw badRequest('INVALID_GUESTS', 'A room needs at least one guest');
  assertFits(room, guests);
  if (guests === 1) return singleRateOf(room);
  return doubleRateOf(room).plus(extraGuestCharge(room).times(guests - 2));
}

export const extraGuestCharge = (room: PricedRoom) => dec(room.additionalGuestPrice ?? EXTRA_GUEST_CHARGE);

/** A room type's occupancy prices (GST excluded), as stored on the type and copied onto each booking. */
export interface RateCard {
  singleRate: Decimal;
  doubleRate: Decimal;
  additionalGuestRate: Decimal;
}

/** 1 guest → single, 2 → double, 3+ → double + (guests − 2) × additional. */
export function occupancyRate(card: RateCard, guests: number): Decimal {
  if (guests <= 1) return card.singleRate;
  return card.doubleRate.plus(card.additionalGuestRate.times(guests - 2));
}

/** Guests spread evenly over the rooms, earlier rooms taking the remainder: 5 over 2 → [3, 2]. */
export function splitGuests(pax: number, rooms: number): number[] {
  const base = Math.floor(pax / rooms);
  return Array.from({ length: rooms }, (_, i) => base + (i < pax % rooms ? 1 : 0));
}

/**
 * The one pricing function for bookings and quotes, so an estimate always
 * matches the booking. Every room needs a guest; no room may exceed `sleeps`.
 */
export function priceBooking(card: RateCard, opts: { rooms: number; pax: number; nights: number; sleeps: number }) {
  if (opts.pax < opts.rooms) throw badRequest('TOO_FEW_GUESTS', 'Each room needs at least one guest');
  if (opts.pax > opts.rooms * opts.sleeps) {
    throw badRequest('TOO_MANY_GUESTS', `This booking can hold at most ${opts.rooms * opts.sleeps} guests`);
  }
  const perRoom = splitGuests(opts.pax, opts.rooms).map((guests) => ({ guests, ratePerNight: occupancyRate(card, guests) }));
  const amount = perRoom.reduce((t, r) => t.plus(r.ratePerNight), dec(0)).times(opts.nights);
  return { nights: opts.nights, perRoom, amount };
}
