import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { dec, MoneyInput } from '../utils/money';

export const ROOM_GST_PCT = '12';
export const FOOD_GST_PCT = '5';

export interface TaxBreakup {
  taxable: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  total: Decimal;
}

@Injectable()
export class TaxService {
  /** GST split equally into CGST and SGST, each rounded to paise. */
  breakup(taxable: MoneyInput, gstPct: MoneyInput): TaxBreakup {
    const base = dec(taxable).toDecimalPlaces(2);
    const half = base.times(dec(gstPct)).dividedBy(200).toDecimalPlaces(2);
    return { taxable: base, cgst: half, sgst: half, total: base.plus(half).plus(half) };
  }

  room(taxable: MoneyInput): TaxBreakup {
    return this.breakup(taxable, ROOM_GST_PCT);
  }

  food(taxable: MoneyInput): TaxBreakup {
    return this.breakup(taxable, FOOD_GST_PCT);
  }
}
