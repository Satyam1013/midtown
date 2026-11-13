import { ConfigService } from '@nestjs/config';
import { BusinessDateService } from '../src/common/services/business-date.service';
import { TaxService } from '../src/common/services/tax.service';
import { dec, toD128 } from '../src/common/utils/money';
import { nightlyRate } from '../src/config/pricing';

describe('money and tax', () => {
  const tax = new TaxService();

  it('adds without floating point drift', () => {
    expect(dec('0.1').plus('0.2').toString()).toBe('0.3');
    expect(toD128('1800').toString()).toBe('1800.00');
  });

  it('room GST is 6% + 6%', () => {
    const b = tax.room('2600');
    expect([b.cgst.toFixed(2), b.sgst.toFixed(2), b.total.toFixed(2)]).toEqual(['156.00', '156.00', '2912.00']);
  });

  it('food GST is 2.5% + 2.5%, to the paisa', () => {
    const b = tax.food('90');
    expect([b.cgst.toFixed(2), b.sgst.toFixed(2), b.total.toFixed(2)]).toEqual(['2.25', '2.25', '94.50']);
  });
});

describe('business date', () => {
  const dates = new BusinessDateService(new ConfigService({ HOTEL_TIMEZONE: 'Asia/Kolkata' }));

  it('uses the hotel timezone, not UTC', () => {
    // 20:00 UTC on the 30th is already the 31st in Raigarh.
    expect(dates.today(new Date('2026-10-30T20:00:00Z'))).toBe('2026-10-31');
  });

  it('rejects impossible dates', () => {
    expect(dates.isRealDate('2026-02-30')).toBe(false);
  });
});

describe('guest pricing rule', () => {
  const room = { rate: toD128('1000'), singleRate: toD128('1000'), doubleRate: toD128('1400') };

  it('1 → single, 2 → double, more → double + 300 each', () => {
    expect([1, 2, 3, 4].map((g) => nightlyRate(room, g).toFixed(2))).toEqual(['1000.00', '1400.00', '1700.00', '2000.00']);
  });

  it('rejects fewer than 1 or more than 4 guests', () => {
    expect(() => nightlyRate(room, 0)).toThrow();
    expect(() => nightlyRate(room, 5)).toThrow();
  });

  it('older rooms with only `rate` price both occupancies at it, with no automatic +300', () => {
    const legacy = { rate: toD128('1800') };
    expect([1, 2, 3].map((g) => nightlyRate(legacy, g).toFixed(2))).toEqual(['1800.00', '1800.00', '2100.00']);
  });
});
