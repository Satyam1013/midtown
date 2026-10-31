import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import ExcelJS from 'exceljs';
import { Model } from 'mongoose';
import { Attendance } from '../attendance/schemas/attendance.schema';
import { Booking } from '../bookings/schemas/booking.schema';
import { CashTxn } from '../cash-transactions/schemas/cash-txn.schema';
import { badRequest } from '../common/errors';
import { serialize } from '../common/interceptors/response.interceptor';
import { DayRegisterEntry } from '../entries/schemas/day-register-entry.schema';
import { Expense } from '../expenses/schemas/expense.schema';
import { OnlineOrder } from '../online-orders/schemas/online-order.schema';
import { Room } from '../rooms/schemas/room.schema';
import { Staff } from '../staff/schemas/staff.schema';
import { StockItem } from '../stock/schemas/stock-item.schema';

export const REPORT_KEYS = ['daily', 'cash', 'rooms', 'bookings', 'expenses', 'stock', 'staff', 'online'] as const;
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
  ) {}

  async build(key: string, date: string): Promise<Report> {
    switch (key as ReportKey) {
      case 'daily':
        return this.table('Daily report', date, ['Time', 'Room', 'Customer', 'Phone', 'Vehicle', 'Type', 'Mode', 'Narration', 'Credit', 'Debit'], await this.entries.aggregate([
          { $match: { businessDate: date } },
          { $sort: { time: 1, createdAt: 1 } },
          { $lookup: { from: 'rooms', localField: 'roomId', foreignField: '_id', as: 'room' } },
          { $project: { row: ['$time', { $ifNull: [{ $first: '$room.number' }, ''] }, '$guestName', { $ifNull: ['$phone', ''] }, { $ifNull: ['$vehicle', ''] }, '$type', '$mode', '$narration', { $cond: [{ $eq: ['$dc', 'CREDIT'] }, num('$amount'), ''] }, { $cond: [{ $eq: ['$dc', 'DEBIT'] }, num('$amount'), ''] }] } },
        ]));
      case 'cash':
        return this.table('Day book', date, ['Head', 'Mode', 'Narration', 'Credit', 'Debit'], await this.cash.aggregate([
          { $match: { businessDate: date } },
          { $sort: { createdAt: 1 } },
          { $project: { row: ['$head', '$mode', '$narration', { $cond: [{ $eq: ['$dc', 'CREDIT'] }, num('$amount'), ''] }, { $cond: [{ $eq: ['$dc', 'DEBIT'] }, num('$amount'), ''] }] } },
        ]));
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
          { $project: { row: ['$head', '$vendor', '$mode', '$narration', num('$amount')] } },
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

  private table(title: string, date: string, head: string[], rows: { row: unknown[] }[]): Report {
    return { title, date, head, rows: serialize(rows.map((r) => r.row)) };
  }
}
