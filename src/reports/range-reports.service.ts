import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';
import { DebitCredit } from '../common/enums';
import { badRequest } from '../common/errors';
import { Paged } from '../common/interceptors/response.interceptor';
import { BusinessDateService } from '../common/services/business-date.service';
import { dec } from '../common/utils/money';
import { DaybookService } from '../daybook/daybook.service';
import { DayRegisterEntry, EntrySource } from '../entries/schemas/day-register-entry.schema';
import { Expense } from '../expenses/schemas/expense.schema';
import { Kot } from '../kots/schemas/kot.schema';
import { OnlineOrder } from '../online-orders/schemas/online-order.schema';
import { LaundryOrder } from '../laundry/schemas/laundry-order.schema';
import { Stay } from '../stays/schemas/stay.schema';

export const MAX_RANGE_DAYS = 366;
export const REPORT_CATEGORIES = ['ROOM', 'FOOD', 'EXPENSE', 'WITHDRAW', 'LAUNDRY', 'OTHER'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** Register sources by report category; anything not listed (MANUAL, REQUEST, CUSTOMER_CREDIT, OTHER, legacy null) is OTHER. */
const SOURCES: Record<Exclude<ReportCategory, 'OTHER'>, EntrySource[]> = {
  ROOM: [EntrySource.CHECKIN, EntrySource.CHECKOUT, EntrySource.STAY_PAYMENT, EntrySource.REFUND],
  FOOD: [EntrySource.RESTAURANT, EntrySource.ROOM_SERVICE, EntrySource.ONLINE],
  EXPENSE: [EntrySource.EXPENSE_PAYMENT],
  WITHDRAW: [EntrySource.WITHDRAW],
  LAUNDRY: [EntrySource.LAUNDRY],
};
const CATEGORISED = Object.values(SOURCES).flat();

const money = (v: unknown) => dec((v as any) ?? 0).toFixed(2);
const CANCELLED = /cancel/i;

export interface Range {
  from: string;
  to: string;
}

export const emptySummary = () => ({ totalSales: '0.00', totalGuests: 0, totalFoodOrders: 0, totalExpenses: '0.00', foodSales: '0.00', totalWithdraw: '0.00', totalLaundry: '0.00' });
export const emptyEntries = (limit = 25) =>
  new Paged([], { page: 1, limit, total: 0 }, { total: 0, page: 1, limit, totals: { credit: '0.00', debit: '0.00' } });

/** GET /reports/summary and /reports/entries: totals and register rows over a business-date range. */
@Injectable()
export class RangeReportsService {
  constructor(
    @InjectModel(DayRegisterEntry.name) private readonly entries: Model<DayRegisterEntry>,
    @InjectModel(Expense.name) private readonly expenses: Model<Expense>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    @InjectModel(Kot.name) private readonly kots: Model<Kot>,
    @InjectModel(OnlineOrder.name) private readonly online: Model<OnlineOrder>,
    @InjectModel(LaundryOrder.name) private readonly laundry: Model<LaundryOrder>,
    private readonly daybook: DaybookService,
    private readonly dates: BusinessDateService,
  ) {}

  /** A missing end takes the other's value; both missing is the open day (else today). 400 on a bad range. */
  async range(from?: string, to?: string): Promise<Range> {
    const start = from ?? to ?? (await this.daybook.openDate()) ?? this.dates.today();
    const end = to ?? start;
    if (!this.dates.isRealDate(start) || !this.dates.isRealDate(end)) throw badRequest('INVALID_DATE', '`from` and `to` must be real YYYY-MM-DD dates');
    if (end < start) throw badRequest('INVALID_RANGE', '`from` must not be after `to`');
    if (this.dates.daysBetween(start, end) + 1 > MAX_RANGE_DAYS) {
      throw badRequest('RANGE_TOO_LONG', `A report covers at most ${MAX_RANGE_DAYS} days`);
    }
    return { from: start, to: end };
  }

  async summary({ from, to }: Range) {
    const inRange = { businessDate: { $gte: from, $lte: to } };
    const [sales, guests, kots, online, expenses, withdrawn, laundry] = await Promise.all([
      // Money received: CREDIT register lines. Refunds and other debits are left out; udhaar
      // (credit given, unpaid) never reaches the register, so it is counted only once paid.
      // A voided stay's payment from an earlier day is taken back by its reversal line.
      this.entries.aggregate<{ total: unknown }>([
        {
          $match: {
            ...inRange,
            $or: [
              { dc: DebitCredit.CREDIT, source: { $ne: EntrySource.REFUND }, reversalOf: { $in: [null] } },
              { dc: DebitCredit.DEBIT, reversalOf: { $type: 'objectId' } },
            ],
          },
        },
        { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$dc', DebitCredit.CREDIT] }, '$amount', { $multiply: ['$amount', -1] }] } } } },
      ]),
      // Each stay once, by its check-in date, at the most guests it ever had.
      this.stays.aggregate<{ total: number }>([
        { $match: { checkIn: { $gte: from, $lte: to } } },
        { $group: { _id: null, total: { $sum: { $max: [{ $ifNull: ['$guests', 1] }, { $max: '$roomCharges.guests' }] } } } },
      ]),
      this.kots.aggregate<{ count: number; total: unknown }>([
        { $match: { ...inRange, status: { $ne: 'CANCELLED' } } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } },
      ]),
      this.online.aggregate<{ count: number; total: unknown }>([
        { $match: { ...inRange, status: { $not: CANCELLED } } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } },
      ]),
      // Full expense amount by its date, on credit or not; later payments aren't added again.
      this.expenses.aggregate<{ total: unknown }>([{ $match: inRange }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      // Money taken out: neither a sale nor an expense, reported on its own.
      this.entries.aggregate<{ total: unknown }>([
        { $match: { ...inRange, source: EntrySource.WITHDRAW, dc: DebitCredit.DEBIT } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      // Delivered laundry by delivery day, GST included (room-billed ones too); cancelled never counts.
      this.laundry.aggregate<{ total: unknown }>([
        { $match: { status: 'DELIVERED', deliveredDate: { $gte: from, $lte: to } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]),
    ]);
    return {
      totalSales: money(sales[0]?.total),
      totalGuests: guests[0]?.total ?? 0,
      totalFoodOrders: (kots[0]?.count ?? 0) + (online[0]?.count ?? 0),
      totalExpenses: money(expenses[0]?.total),
      foodSales: dec((kots[0]?.total as any) ?? 0).plus(dec((online[0]?.total as any) ?? 0)).toFixed(2),
      totalWithdraw: money(withdrawn[0]?.total),
      totalLaundry: money(laundry[0]?.total),
    };
  }

  /**
   * Register lines (credits and debits) and expenses, newest first, paged in the
   * database. `total` and `totals` cover the whole range and category. An expense
   * bought on credit is listed but left out of `totals.debit`, as in the day book:
   * its payments are the EXPENSE_PAYMENT lines.
   */
  async rows({ from, to }: Range, category: ReportCategory | undefined, page: number, limit: number) {
    const inRange = { businessDate: { $gte: from, $lte: to } };
    const sourceFilter =
      category === 'OTHER' ? { source: { $nin: CATEGORISED } } : category ? { source: { $in: SOURCES[category] } } : {};
    const withExpenses = !category || category === 'EXPENSE';
    const categoryOf = {
      $switch: {
        branches: (Object.keys(SOURCES) as (keyof typeof SOURCES)[]).map((c) => ({ case: { $in: ['$source', SOURCES[c]] }, then: c })),
        default: 'OTHER',
      },
    };

    const pipeline: PipelineStage[] = [
      { $match: { ...inRange, ...sourceFilter } },
      {
        $project: {
          businessDate: 1, time: 1, roomId: 1, guestName: 1, type: 1, mode: 1, dc: 1, amount: 1, narration: 1,
          source: { $ifNull: ['$source', EntrySource.MANUAL] },
          category: categoryOf,
          counted: { $literal: true },
        },
      },
    ];
    if (withExpenses) {
      pipeline.push({
        $unionWith: {
          coll: 'expenses',
          pipeline: [
            { $match: { deletedAt: null, ...inRange } },
            {
              $project: {
                businessDate: 1, time: { $ifNull: ['$time', ''] }, roomId: null, guestName: '$vendor', type: '$head',
                mode: 1, dc: { $literal: DebitCredit.DEBIT }, amount: 1, narration: 1,
                source: { $literal: 'EXPENSE' }, category: { $literal: 'EXPENSE' },
                counted: { $not: [{ $ifNull: ['$onCredit', false] }] },
                onCredit: { $ifNull: ['$onCredit', false] },
              },
            },
          ],
        },
      });
    }
    pipeline.push({
      $facet: {
        rows: [
          { $sort: { businessDate: -1, time: -1, _id: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $lookup: { from: 'rooms', localField: 'roomId', foreignField: '_id', as: 'room', pipeline: [{ $project: { number: 1 } }] } },
        ],
        count: [{ $count: 'n' }],
        totals: [{ $match: { counted: true } }, { $group: { _id: '$dc', total: { $sum: '$amount' } } }],
      },
    });

    const [result] = await this.entries.aggregate<{ rows: any[]; count: { n: number }[]; totals: { _id: DebitCredit; total: unknown }[] }>(pipeline);
    const total = result.count[0]?.n ?? 0;
    const sumOf = (dc: DebitCredit) => money(result.totals.find((t) => t._id === dc)?.total);
    const data = result.rows.map((r) => ({
      id: String(r._id),
      businessDate: r.businessDate,
      time: r.time ?? '',
      roomNumber: r.room?.[0]?.number ?? null,
      guestName: r.guestName ?? '',
      type: r.type,
      mode: r.mode ?? null,
      dc: r.dc,
      amount: money(r.amount),
      narration: r.narration ?? '',
      source: r.source,
      category: r.category,
      ...(r.source === 'EXPENSE' ? { onCredit: !!r.onCredit } : {}),
    }));
    return new Paged(data, { page, limit, total }, {
      total,
      page,
      limit,
      totals: { credit: sumOf(DebitCredit.CREDIT), debit: sumOf(DebitCredit.DEBIT) },
    });
  }
}
