import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { dec, MoneyInput } from '../utils/money';
import { TaxBreakup } from './tax.service';

export type GstSection = 'STAY' | 'FOOD' | 'OTHER';

/** How a stay is taxed. Stays from before configurable GST carry none and use 12% on top. */
export interface StayGstMode {
  inclusive: boolean;
}

export const LEGACY_ROOM_GST_PCT = 12;

/**
 * GST settings, from the environment with these defaults:
 *   GST_TAX_INCLUSIVE=false        prices exclude GST; GST is added on top
 *   GST_ROOM_SLAB_LIMIT=7500       nightly rate up to this → GST_ROOM_LOW_PCT, above → GST_ROOM_HIGH_PCT
 *   GST_ROOM_LOW_PCT=5  GST_ROOM_HIGH_PCT=18  GST_FOOD_PCT=5  GST_OTHER_PCT=18
 *   HOTEL_GSTIN, HOTEL_NAME, BILL_PREFIX=MTH
 *   SAC_ROOM=996311  SAC_FOOD=996331  SAC_OTHER=9997
 */
@Injectable()
export class GstService {
  constructor(private readonly config: ConfigService) {}

  get settings() {
    const n = (key: string, fallback: number) => {
      const v = Number(this.config.get<string>(key));
      return Number.isFinite(v) && this.config.get(key) !== undefined && this.config.get(key) !== '' ? v : fallback;
    };
    const s = (key: string, fallback: string) => this.config.get<string>(key) || fallback;
    return {
      taxInclusive: String(this.config.get('GST_TAX_INCLUSIVE') ?? 'false').toLowerCase() === 'true',
      roomSlabLimit: n('GST_ROOM_SLAB_LIMIT', 7500),
      roomLowPct: n('GST_ROOM_LOW_PCT', 5),
      roomHighPct: n('GST_ROOM_HIGH_PCT', 18),
      foodPct: n('GST_FOOD_PCT', 5),
      otherPct: n('GST_OTHER_PCT', 18),
      gstin: s('HOTEL_GSTIN', ''),
      hotelName: s('HOTEL_NAME', 'Midtown Hotel'),
      billPrefix: s('BILL_PREFIX', 'MTH'),
      sac: { STAY: s('SAC_ROOM', '996311'), FOOD: s('SAC_FOOD', '996331'), OTHER: s('SAC_OTHER', '9997') } as Record<GstSection, string>,
    };
  }

  /** The mode a new stay is created with. */
  newStayMode(): StayGstMode {
    return { inclusive: this.settings.taxInclusive };
  }

  /** Room slab by nightly rate. */
  roomPct(nightlyRate: MoneyInput, mode: StayGstMode | null | undefined): number {
    if (!mode) return LEGACY_ROOM_GST_PCT;
    const s = this.settings;
    return dec(nightlyRate).lte(s.roomSlabLimit) ? s.roomLowPct : s.roomHighPct;
  }

  /**
   * Splits a charge into taxable value, CGST and SGST (always equal).
   * Exclusive: `amount` is the taxable value and GST goes on top.
   * Inclusive: `amount` is what the guest pays and GST is inside it.
   */
  charge(amount: MoneyInput, pct: MoneyInput, inclusive: boolean): TaxBreakup {
    const a = dec(amount).toDecimalPlaces(2);
    const p = dec(pct);
    if (!inclusive) {
      const half = a.times(p).dividedBy(200).toDecimalPlaces(2);
      return { taxable: a, cgst: half, sgst: half, total: a.plus(half).plus(half) };
    }
    // GST inside the price: half = total × p / (200 + 2p), so CGST == SGST and they add back exactly.
    const half = a.times(p).dividedBy(dec(200).plus(p.times(2))).toDecimalPlaces(2);
    return { taxable: a.minus(half.times(2)), cgst: half, sgst: half, total: a };
  }

  /** Breakup of a folio amount already including GST (for lines stored before breakups). */
  fromTotal(total: MoneyInput, pct: MoneyInput): TaxBreakup {
    return this.charge(total, pct, true);
  }

  food(amount: MoneyInput): TaxBreakup {
    return this.charge(amount, this.settings.foodPct, this.settings.taxInclusive);
  }

  other(amount: MoneyInput): TaxBreakup {
    return this.charge(amount, this.settings.otherPct, this.settings.taxInclusive);
  }

  /** Indian financial year of a business date: 2026-11-15 → "2026-27". */
  financialYear(date: string) {
    const [y, m] = date.split('-').map(Number);
    const start = m >= 4 ? y : y - 1;
    return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
  }
}

export const sumBreakups = (parts: TaxBreakup[]): TaxBreakup =>
  parts.reduce(
    (t, p) => ({ taxable: t.taxable.plus(p.taxable), cgst: t.cgst.plus(p.cgst), sgst: t.sgst.plus(p.sgst), total: t.total.plus(p.total) }),
    { taxable: new Decimal(0), cgst: new Decimal(0), sgst: new Decimal(0), total: new Decimal(0) },
  );
