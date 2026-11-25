import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { conflict, notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { BusinessDateService } from '../common/services/business-date.service';
import { GstSection, GstService, LEGACY_ROOM_GST_PCT, sumBreakups } from '../common/services/gst.service';
import { TaxBreakup } from '../common/services/tax.service';
import { dec } from '../common/utils/money';
import { DaybookService } from '../daybook/daybook.service';
import { TransactionService } from '../database/transaction.service';
import { DayRegisterEntry } from '../entries/schemas/day-register-entry.schema';
import { FolioLine, FolioSource } from '../folio/schemas/folio-line.schema';
import { Kot } from '../kots/schemas/kot.schema';
import { Room } from '../rooms/schemas/room.schema';
import { BillPrintDto, BillTaxDto } from './dto/stay.dto';
import { BillPrint, BillSectionAmounts } from './schemas/bill-print.schema';
import { Stay, StayStatus } from './schemas/stay.schema';
import { billTaxView, StayViewService } from './stay-view.service';

const SOURCE_SECTION: Partial<Record<FolioSource, GstSection>> = {
  [FolioSource.TARIFF]: 'STAY',
  [FolioSource.FOOD]: 'FOOD',
  [FolioSource.OTHER]: 'OTHER',
};

const money = (d: { toFixed(n: number): string }) => d.toFixed(2);

type BillItem = { description: string; qty: number; rate: string; amount: string; gstRate: number | null };

/**
 * With fixed rates the section's taxable value changes, so its items are scaled
 * to add up to it exactly (the last item takes the rounding), at the fixed rate.
 */
function rescale(items: BillItem[], taxable: ReturnType<typeof dec>, pct: number): BillItem[] {
  const sum = items.reduce((t, i) => t.plus(dec(i.amount)), dec(0));
  if (sum.isZero()) return items.map((i) => ({ ...i, gstRate: pct }));
  let left = taxable;
  return items.map((i, n) => {
    const amount = n === items.length - 1 ? left : dec(i.amount).times(taxable).dividedBy(sum).toDecimalPlaces(2);
    left = left.minus(amount);
    return { ...i, amount: money(amount), rate: money(i.qty ? amount.dividedBy(i.qty) : amount), gstRate: pct };
  });
}

/** The guest bill, built from the folio: sections, CGST/SGST, payments and balance. */
@Injectable()
export class StayBillService {
  constructor(
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    @InjectModel(FolioLine.name) private readonly folio: Model<FolioLine>,
    @InjectModel(DayRegisterEntry.name) private readonly entries: Model<DayRegisterEntry>,
    @InjectModel(Kot.name) private readonly kots: Model<Kot>,
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(BillPrint.name) private readonly prints: Model<BillPrint>,
    private readonly view: StayViewService,
    private readonly gst: GstService,
    private readonly audit: AuditService,
    private readonly daybook: DaybookService,
    private readonly dates: BusinessDateService,
    private readonly tx: TransactionService,
  ) {}

  async build(stayId: Types.ObjectId) {
    const stay = await this.stays.findById(stayId).lean();
    if (!stay) throw notFound('Stay');
    const [decorated] = await this.view.decorate([stay]);
    const lines = await this.folio.find({ stayId }).sort({ createdAt: 1 }).lean();
    const kotIds = lines.map((l) => l.kotId).filter(Boolean);
    const [kots, entries, room] = await Promise.all([
      this.kots.find({ _id: { $in: kotIds } }).lean(),
      this.entries.find({ _id: { $in: lines.map((l) => l.entryId).filter(Boolean) } }).lean(),
      this.rooms.findById(stay.roomId).select('number').setOptions({ withDeleted: true }).lean(),
    ]);
    const kotOf = new Map(kots.map((k) => [String(k._id), k]));
    const entryOf = new Map(entries.map((e) => [String(e._id), e]));
    const s = this.gst.settings;
    const defaultPct: Record<GstSection, number> = { STAY: LEGACY_ROOM_GST_PCT, FOOD: s.foodPct, OTHER: s.otherPct };
    // Rates the manager fixed for this bill: each line's amount (GST included) is
    // split again at the section's rate. Totals, payments and balance stay the same.
    const fixed = stay.billTax ? ({ STAY: stay.billTax.stay, FOOD: stay.billTax.food, OTHER: stay.billTax.other } as Record<GstSection, number>) : null;

    const breakupOf = (l: (typeof lines)[number], section: GstSection): TaxBreakup & { pct: number } => {
      if (fixed) return { pct: fixed[section], ...this.gst.fromTotal(l.amount, fixed[section]) };
      const pct = l.gstPct ?? defaultPct[section];
      if (l.taxable && l.cgst && l.sgst) {
        return { pct, taxable: dec(l.taxable), cgst: dec(l.cgst), sgst: dec(l.sgst), total: dec(l.amount) };
      }
      return { pct, ...this.gst.fromTotal(l.amount, pct) };
    };

    const sections = (['STAY', 'FOOD', 'OTHER'] as GstSection[]).map((key) => {
      const own = lines.filter((l) => SOURCE_SECTION[l.source] === key || (l.source === FolioSource.ADJUSTMENT && (l.section ?? 'STAY') === key));
      const adjustments = own.filter((l) => l.source === FolioSource.ADJUSTMENT);
      const parts = own.map((l) => breakupOf(l, key));
      const totals = sumBreakups(parts);
      const rates = [...new Set(parts.map((p) => p.pct))];
      let items: BillItem[];
      const adjustmentItems = adjustments.map((l) => {
        const p = parts[own.indexOf(l)];
        return { description: l.head, qty: 1, rate: money(p.taxable), amount: money(p.taxable), gstRate: p.pct };
      });
      if (key === 'STAY') {
        items = decorated.roomCharges.map((c: any) => ({
          description: `${c.label}, ${c.guests} guest${c.guests === 1 ? '' : 's'}`,
          qty: c.nights,
          rate: money(dec(c.rate)),
          amount: money(dec(c.rate).times(c.nights)),
          gstRate: c.gstPct ?? (stay.gst ? null : LEGACY_ROOM_GST_PCT),
        }));
        items.push(...adjustmentItems);
      } else {
        items = own.filter((l) => l.source !== FolioSource.ADJUSTMENT).flatMap((l) => {
          const i = own.indexOf(l);
          const kot = l.kotId ? kotOf.get(String(l.kotId)) : null;
          if (kot) {
            return kot.items.map((it) => ({
              description: `${it.name} (KOT #${kot.number})`,
              qty: it.qty,
              rate: money(dec(it.price)),
              amount: money(dec(it.price).times(it.qty)),
              gstRate: parts[i].pct,
            }));
          }
          return [{ description: l.head, qty: 1, rate: money(parts[i].taxable), amount: money(parts[i].taxable), gstRate: parts[i].pct }];
        });
        items.push(...adjustmentItems);
      }
      if (fixed) items = rescale(items, totals.taxable, fixed[key]);
      return {
        key,
        sac: s.sac[key],
        gstRate: fixed ? fixed[key] : rates.length === 1 ? rates[0] : rates.length ? null : key === 'STAY' ? this.gst.roomPct(stay.rate, stay.gst) : defaultPct[key],
        lines: items,
        taxable: money(totals.taxable),
        cgst: money(totals.cgst),
        sgst: money(totals.sgst),
        total: money(totals.total),
      };
    });

    // Payments: the folio's PAYMENT (negative) and REFUND (positive) lines, with the mode of their register entry.
    const byMode = new Map<string, ReturnType<typeof dec>>();
    for (const l of lines.filter((x) => [FolioSource.PAYMENT, FolioSource.REFUND, FolioSource.CREDIT].includes(x.source))) {
      const e = l.entryId ? entryOf.get(String(l.entryId)) : null;
      const mode = l.source === FolioSource.CREDIT ? 'CREDIT' : (e?.mode ?? 'OTHER');
      byMode.set(mode, (byMode.get(mode) ?? dec(0)).minus(dec(l.amount)));
    }
    const paid = [...byMode.values()].reduce((a, b) => a.plus(b), dec(0));
    const grand = sumBreakups(sections.map((x) => ({ taxable: dec(x.taxable), cgst: dec(x.cgst), sgst: dec(x.sgst), total: dec(x.total) })));
    return {
      billNo: stay.billNo,
      billDate: stay.billDate,
      provisional: !stay.billNo,
      hotel: { name: s.hotelName, gstin: s.gstin || null },
      taxInclusive: stay.gst?.inclusive ?? false,
      billTax: billTaxView(stay.billTax),
      stayId: stay._id,
      guestName: stay.guestName,
      phone: stay.phone,
      roomNumber: room?.number ?? null,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      nights: stay.nights,
      guests: stay.guests ?? 1,
      sections,
      taxable: money(grand.taxable),
      cgst: money(grand.cgst),
      sgst: money(grand.sgst),
      total: money(grand.total),
      payments: [...byMode.entries()].filter(([, a]) => !a.isZero()).map(([mode, amount]) => ({ mode, amount: money(amount) })),
      paid: money(paid),
      balance: money(grand.total.minus(paid)),
    };
  }

  /** Records a bill print for audit. Changes nothing else. */
  async recordPrint(stayId: Types.ObjectId, dto: BillPrintDto, user: Principal) {
    const bill = await this.build(stayId);
    const section = (key: string) => bill.sections.find((x) => x.key === key)!.total;
    const norm = (a?: { stay?: string; food?: string; other?: string }): BillSectionAmounts => {
      const v = (x?: string) => (x === undefined || x === null ? null : money(dec(x)));
      const out = { stay: v(a?.stay), food: v(a?.food), other: v(a?.other) };
      return { ...out, total: money([out.stay, out.food, out.other].reduce((t, x) => t.plus(x ?? 0), dec(0))) };
    };
    const amounts = norm(dto.amounts);
    const actualAmounts = norm(dto.actualAmounts);
    const serverAmounts = norm({ stay: section('STAY'), food: section('FOOD'), other: section('OTHER') });
    const diff = (k: 'stay' | 'food' | 'other' | 'total') =>
      amounts[k] === null && actualAmounts[k] === null ? null : money(dec(amounts[k] ?? 0).minus(dec(actualAmounts[k] ?? 0)));
    const difference = { stay: diff('stay'), food: diff('food'), other: diff('other'), total: diff('total')! };
    const businessDate = (await this.daybook.openDate()) ?? this.dates.today();
    const record = await this.prints.create({
      stayId,
      userId: userObjectId(user),
      businessDate,
      type: dto.type,
      which: dto.which,
      billNo: bill.billNo,
      amounts,
      actualAmounts,
      serverAmounts,
      difference,
      billTax: bill.billTax ? { stay: bill.billTax.stay, food: bill.billTax.food, other: bill.billTax.other } : null,
    });
    await this.audit.record(AuditAction.BILL_PRINT, stayId, userObjectId(user), { printId: record._id, type: dto.type, which: dto.which, amounts, actualAmounts, difference }, null, businessDate);
    return record;
  }

  /**
   * PUT /stays/:id/bill-tax: fixes the bill's GST rates, overwriting any saved
   * ones (no merge). In-house stays only. Audited with the old and new rates.
   */
  async setBillTax(stayId: Types.ObjectId, dto: BillTaxDto, user: Principal) {
    const rates = { stay: dto.rates.stay, food: dto.rates.food, other: dto.rates.other };
    return this.tx.run(async ({ session }) => {
      const stay = await this.stays.findById(stayId).session(session);
      if (!stay) throw notFound('Stay');
      if (stay.status !== StayStatus.IN_HOUSE) throw conflict('STAY_CLOSED', 'This stay has checked out; its GST rates can no longer be changed');
      const old = billTaxView(stay.billTax);
      const billTax = { ...rates, updatedBy: userObjectId(user), updatedAt: new Date() };
      // The status check is repeated in the write, so a check-out racing this call wins cleanly.
      const saved = await this.stays.findOneAndUpdate({ _id: stayId, status: StayStatus.IN_HOUSE }, { $set: { billTax } }, { new: true, session }).lean();
      if (!saved) throw conflict('STAY_CLOSED', 'This stay has checked out; its GST rates can no longer be changed');
      const businessDate = (await this.daybook.openDate()) ?? this.dates.today();
      await this.audit.record(
        AuditAction.BILL_TAX_UPDATE,
        stayId,
        userObjectId(user),
        { old: old ? { stay: old.stay, food: old.food, other: old.other } : null, new: rates },
        session,
        businessDate,
      );
      return { stayId, billTax: rates, updatedBy: billTax.updatedBy, updatedAt: billTax.updatedAt };
    });
  }

  listPrints(stayId: Types.ObjectId) {
    return this.prints.find({ stayId }).sort({ createdAt: -1 }).lean();
  }

  /** Next bill number of the financial year, e.g. MTH/2026-27/00123. Inside the checkout transaction. */
  static format(prefix: string, fy: string, seq: number) {
    return `${prefix}/${fy}/${String(seq).padStart(5, '0')}`;
  }
}
