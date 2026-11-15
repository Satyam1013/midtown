import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import ExcelJS from 'exceljs';
import { Model, Types } from 'mongoose';
import { Attendance } from '../attendance/schemas/attendance.schema';
import { Booking } from '../bookings/schemas/booking.schema';
import { CashTxn } from '../cash-transactions/schemas/cash-txn.schema';
import { badRequest } from '../common/errors';
import { serialize } from '../common/interceptors/response.interceptor';
import { DayRegisterEntry } from '../entries/schemas/day-register-entry.schema';
import { Expense } from '../expenses/schemas/expense.schema';
import { OnlineOrder } from '../online-orders/schemas/online-order.schema';
import { BillPrint } from '../stays/schemas/bill-print.schema';
import { Settlement } from '../stays/schemas/settlement.schema';
import { DaybookService } from '../daybook/daybook.service';
import { Customer } from '../customers/schemas/customer.schema';
import { CreditKind, CustomerCreditEntry } from '../customers/schemas/customer-credit-entry.schema';
import Decimal from 'decimal.js';
import { dec } from '../common/utils/money';
import { Room } from '../rooms/schemas/room.schema';
import { Staff } from '../staff/schemas/staff.schema';
import { StockItem } from '../stock/schemas/stock-item.schema';

export const REPORT_KEYS = ['daily', 'cash', 'rooms', 'bookings', 'expenses', 'stock', 'staff', 'online', 'manual-bills', 'receivables', 'payables'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export interface Report {
  title: string;
  date: string;
  head: string[];
  rows: unknown[][];
}

const num = (field: string) => ({ $toDouble: field }); // display only: no arithmetic follows

// Titles and columns match the manager app's src/lib/reports.js.
@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(DayRegisterEntry.name) private readonly entries: Model<DayRegisterEntry>,
    @InjectModel(CashTxn.name) private readonly cash: Model<CashTxn>,
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(Booking.name) private readonly bookings: Model<Booking>,
    @InjectModel(Expense.name) private readonly expenses: Model<Expense>,
    @InjectModel(StockItem.name) private readonly stock: Model<StockItem>,
    @InjectModel(Staff.name) private readonly staff: Model<Staff>,
    @InjectModel(Attendance.name) private readonly attendance: Model<Attendance>,
    @InjectModel(OnlineOrder.name) private readonly online: Model<OnlineOrder>,
    @InjectModel(BillPrint.name) private readonly prints: Model<BillPrint>,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(CustomerCreditEntry.name) private readonly credit: Model<CustomerCreditEntry>,
    @InjectModel(Settlement.name) private readonly settlements: Model<Settlement>,
    private readonly daybook: DaybookService,
  ) {}

  async build(key: string, date: string): Promise<Report> {
    switch (key as ReportKey) {
      case 'daily': {
        // Same lines as the register: one per check-out, expenses left out (they have their own report).
        const lines = (await this.daybook.register(date)).filter((l: any) => l.kind === 'entry');
        const n = (v: unknown) => Number(String(v));
        return this.table('Daily report', date, ['Time', 'Room', 'Customer', 'Phone', 'Vehicle', 'Type', 'Mode', 'Narration', 'Credit', 'Debit', 'Short by'], lines.map((l: any) => ({
          row: [l.time, l.roomNumber ?? '', l.guestName, l.phone ?? '', l.vehicle ?? '', l.type, l.mode ?? '', l.narration, l.dc === 'CREDIT' ? n(l.amount) : '', l.dc === 'DEBIT' ? n(l.amount) : '', l.shortfall ? n(l.shortfall) : ''],
        })));
      }
      case 'cash': {
        // Cash-book lines, with the per-mode lines of one check-out merged into one row.
        const txns = await this.cash.find({ businessDate: date }).sort({ createdAt: 1 }).lean();
        const owners = await this.entries.find({ _id: { $in: txns.map((t) => t.entryId).filter(Boolean) }, settlementId: { $ne: null } }).select('settlementId').lean();
        const settlementOf = new Map(owners.map((e) => [String(e._id), String(e.settlementId)]));
        const settlements = await this.settlements.find({ _id: { $in: [...new Set(settlementOf.values())] } }).lean();
        const rows: { row: unknown[] }[] = [];
        const merged = new Map<string, { row: unknown[] }>();
        for (const t of txns) {
          const sid = t.entryId ? settlementOf.get(String(t.entryId)) : undefined;
          const amount = Number(String(t.amount));
          if (!sid) {
            rows.push({ row: [t.head, t.mode, t.narration, t.dc === 'CREDIT' ? amount : '', t.dc === 'DEBIT' ? amount : ''] });
            continue;
          }
          const existing = merged.get(sid);
          if (existing) {
            existing.row[3] = (existing.row[3] as number) + amount;
            if (existing.row[1] !== t.mode) existing.row[1] = 'MIXED';
          } else {
            const x = settlements.find((s) => String(s._id) === sid);
            const line = { row: ['Check-out', t.mode, x?.narration || x?.guestName || '', amount, ''] };
            merged.set(sid, line);
            rows.push(line);
          }
        }
        return this.table('Day book', date, ['Head', 'Mode', 'Narration', 'Credit', 'Debit'], rows);
      }
      case 'rooms':
        return this.table('Room status & guest register', date, ['Room', 'Type', 'Status', 'Guest', 'Phone', 'Vehicle', 'Check-in', 'Check-out', 'Nights', 'Folio'], await this.rooms.aggregate([
          { $sort: { floor: 1, number: 1 } },
          { $lookup: { from: 'room_types', localField: 'roomTypeId', foreignField: '_id', as: 'type' } },
          { $lookup: { from: 'stays', let: { room: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$roomId', '$$room'] }, status: 'IN_HOUSE', deletedAt: null } }], as: 'stay' } },
          { $set: { stay: { $first: '$stay' } } },
          { $lookup: { from: 'folio_lines', let: { stay: '$stay._id' }, pipeline: [{ $match: { $expr: { $eq: ['$stayId', '$$stay'] }, deletedAt: null } }, { $group: { _id: null, balance: { $sum: '$amount' } } }], as: 'folio' } },
          { $project: { row: ['$number', { $ifNull: [{ $first: '$type.name' }, ''] }, '$status', { $ifNull: ['$stay.guestName', ''] }, { $ifNull: ['$stay.phone', ''] }, { $ifNull: ['$stay.vehicle', ''] }, { $ifNull: ['$stay.checkIn', ''] }, { $ifNull: ['$stay.checkOut', ''] }, { $ifNull: ['$stay.nights', ''] }, { $ifNull: [num({ $first: '$folio.balance' } as any), 0] }] } },
        ]));
      case 'bookings':
        return this.table('Bookings', date, ['Source', 'Reference', 'Guest', 'Phone', 'Type', 'Rooms', 'Check-in', 'Amount', 'Payment', 'Status'], await this.bookings.aggregate([
          { $match: { arrivalDate: date } },
          { $sort: { createdAt: 1 } },
          { $lookup: { from: 'room_types', localField: 'roomTypeId', foreignField: '_id', as: 'type' } },
          { $project: { row: ['$source', { $ifNull: ['$ref', ''] }, '$guestName', '$phone', { $ifNull: [{ $first: '$type.name' }, ''] }, '$rooms', '$arrivalDate', num('$amount'), '$payment', '$status'] } },
        ]));
      case 'expenses':
        return this.table('Expenses', date, ['Head', 'Paid to', 'Mode', 'Narration', 'Amount'], await this.expenses.aggregate([
          { $match: { businessDate: date } },
          { $sort: { createdAt: 1 } },
          // Credit expenses count on the day they were booked (accrual); their mode reads "Credit".
          { $project: { row: ['$head', '$vendor', { $ifNull: ['$mode', 'Credit'] }, '$narration', num('$amount')] } },
        ]));
      case 'stock':
        return this.table('Inventory', date, ['Item', 'Department', 'Stock', 'Unit', 'Minimum', 'Rate', 'Value'], await this.stock.aggregate([
          { $sort: { category: 1, item: 1 } },
          { $project: { row: ['$item', '$category', num('$qty'), '$unit', num('$minQty'), num('$rate'), num({ $multiply: ['$qty', '$rate'] } as any)] } },
        ]));
      case 'staff':
        return this.table('Staff attendance', date, ['Name', 'Role', 'Shift', 'Salary', 'Attendance'], await this.staff.aggregate([
          { $sort: { name: 1 } },
          { $lookup: { from: 'attendance', let: { staff: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$staffId', '$$staff'] }, businessDate: date, deletedAt: null } }], as: 'mark' } },
          { $set: { mark: { $first: '$mark.mark' } } },
          { $project: { row: ['$name', '$role', '$shift', num('$salary'), { $switch: { branches: [{ case: { $eq: ['$mark', 'P'] }, then: 'Present' }, { case: { $eq: ['$mark', 'A'] }, then: 'Absent' }, { case: { $eq: ['$mark', 'L'] }, then: 'Leave' }], default: '' } }] } },
        ]));
      case 'receivables':
        return this.table('Customer receivables', date, ['Customer', 'Phone', 'Outstanding', '0-30 days', '31-60 days', '61-90 days', '90+ days', 'Oldest unpaid since'], await this.receivables(date));
      case 'payables':
        return this.table('Payables', date, ['Vendor', 'Bills', 'Outstanding', '0-30 days', '31-60 days', '61-90 days', '90+ days', 'Overdue', 'Next due'], await this.payables(date));
      case 'manual-bills':
        // Manual (presentation) bills printed that business day, against the real bill.
        return this.table('Manual bills printed', date, ['Time', 'User', 'Room', 'Guest', 'Bill no', 'Printed', 'Actual total', 'Manual total', 'Difference'], await this.prints.aggregate([
          { $match: { businessDate: date, type: 'MANUAL' } },
          { $sort: { createdAt: 1 } },
          { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
          { $lookup: { from: 'stays', localField: 'stayId', foreignField: '_id', as: 'stay' } },
          { $set: { stay: { $first: '$stay' } } },
          { $lookup: { from: 'rooms', localField: 'stay.roomId', foreignField: '_id', as: 'room' } },
          {
            $project: {
              row: [
                { $dateToString: { date: '$createdAt', format: '%H:%M', timezone: 'Asia/Kolkata' } },
                { $ifNull: [{ $first: '$user.name' }, ''] },
                { $ifNull: [{ $first: '$room.number' }, ''] },
                { $ifNull: ['$stay.guestName', ''] },
                { $ifNull: ['$billNo', ''] },
                '$which',
                { $toDouble: '$serverAmounts.total' },
                { $toDouble: '$amounts.total' },
                { $subtract: [{ $toDouble: '$amounts.total' }, { $toDouble: '$serverAmounts.total' }] },
              ],
            },
          },
        ]));
      case 'online':
        return this.table('Online food orders', date, ['Platform', 'Order ID', 'Time', 'Items', 'Order value', 'Net payout', 'Status'], await this.online.aggregate([
          { $match: { businessDate: date } },
          { $sort: { createdAt: 1 } },
          { $project: { row: ['$platform', '$orderId', { $dateToString: { date: '$createdAt', format: '%H:%M', timezone: 'Asia/Kolkata' } }, { $reduce: { input: '$items', initialValue: '', in: { $concat: ['$$value', { $cond: [{ $eq: ['$$value', ''] }, '', ', '] }, { $toString: '$$this.qty' }, '× ', '$$this.name'] } } }, num('$amount'), num('$payout'), '$status'] } },
        ]));
      default:
        throw badRequest('UNKNOWN_REPORT', `Unknown report. Use one of: ${REPORT_KEYS.join(', ')}`);
    }
  }

  async toXlsx(report: Report): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet(report.title.slice(0, 31).replace(/[*?:/\\[\]]/g, ' '));
    sheet.addRow([`The Midtown Hotel: ${report.title}`]).font = { bold: true, size: 13 };
    sheet.addRow([`Date: ${report.date}`]);
    sheet.addRow([]);
    sheet.addRow(report.head).font = { bold: true };
    report.rows.forEach((row) => sheet.addRow(row as ExcelJS.CellValue[]));
    sheet.columns.forEach((col, i) => {
      const longest = Math.max(report.head[i]?.length ?? 8, ...report.rows.map((r) => String(r[i] ?? '').length));
      col.width = Math.min(45, longest + 2);
    });
    sheet.views = [{ state: 'frozen', ySplit: 4 }];
    return Buffer.from(await book.xlsx.writeBuffer());
  }

  /**
   * What each customer owes as of `date`, aged by the date of each charge.
   * Payments settle the oldest charges first.
   */
  private async receivables(date: string) {
    const owing = await this.customers.find({ creditBalance: { $gt: Types.Decimal128.fromString('0') } }).sort({ name: 1 }).lean();
    const entries = await this.credit.find({ customerId: { $in: owing.map((c) => c._id) }, businessDate: { $lte: date } }).sort({ businessDate: 1, createdAt: 1 }).lean();
    return owing
      .map((c) => {
        const own = entries.filter((e) => String(e.customerId) === String(c._id));
        let paid = own.filter((e) => e.kind === CreditKind.PAYMENT).reduce((t, e) => t.plus(dec(e.amount)), dec(0));
        const buckets = [dec(0), dec(0), dec(0), dec(0)];
        let oldest: string | null = null;
        for (const charge of own.filter((e) => e.kind === CreditKind.CHARGE)) {
          const settled = Decimal.min(paid, dec(charge.amount));
          paid = paid.minus(settled);
          const open = dec(charge.amount).minus(settled);
          if (open.lte(0)) continue;
          oldest ??= charge.businessDate;
          buckets[this.bucket(charge.businessDate, date)] = buckets[this.bucket(charge.businessDate, date)].plus(open);
        }
        const outstanding = buckets.reduce((t, b) => t.plus(b), dec(0));
        return { outstanding, row: [c.name || '', c.phone ?? '', outstanding.toNumber(), ...buckets.map((b) => b.toNumber()), oldest ?? ''] };
      })
      .filter((r) => r.outstanding.gt(0))
      .map(({ row }) => ({ row }));
  }

  /** What the hotel owes each vendor for expenses on credit, aged by booking date, with overdue amounts. */
  private async payables(date: string) {
    const due = await this.expenses
      .find({ onCredit: true, dueAmount: { $gt: Types.Decimal128.fromString('0') }, businessDate: { $lte: date } })
      .sort({ vendor: 1, businessDate: 1 })
      .lean();
    const vendors = new Map<string, typeof due>();
    for (const e of due) vendors.set(e.vendor, [...(vendors.get(e.vendor) ?? []), e]);
    return [...vendors.entries()].map(([vendor, list]) => {
      const buckets = [dec(0), dec(0), dec(0), dec(0)];
      let overdue = dec(0);
      for (const e of list) {
        buckets[this.bucket(e.businessDate, date)] = buckets[this.bucket(e.businessDate, date)].plus(dec(e.dueAmount));
        if (e.dueDate && e.dueDate < date) overdue = overdue.plus(dec(e.dueAmount));
      }
      const next = list.map((e) => e.dueDate).filter((d): d is string => !!d && d >= date).sort()[0] ?? '';
      const outstanding = buckets.reduce((t, b) => t.plus(b), dec(0));
      return { row: [vendor, list.length, outstanding.toNumber(), ...buckets.map((b) => b.toNumber()), overdue.toNumber(), next] };
    });
  }

  /** 0: 0-30 days, 1: 31-60, 2: 61-90, 3: over 90. */
  private bucket(from: string, to: string) {
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
    return days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
  }

  private table(title: string, date: string, head: string[], rows: { row: unknown[] }[]): Report {
    return { title, date, head, rows: serialize(rows.map((r) => r.row)) };
  }
}
