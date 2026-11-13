import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import Decimal from 'decimal.js';
import { ClientSession, Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { CashTxn } from '../cash-transactions/schemas/cash-txn.schema';
import { DebitCredit, PaymentMode } from '../common/enums';
import { badRequest, conflict, notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { BusinessDateService } from '../common/services/business-date.service';
import { dec, toD128 } from '../common/utils/money';
import { TransactionService } from '../database/transaction.service';
import { DayRegisterEntry, EntrySource } from '../entries/schemas/day-register-entry.schema';
import { Expense } from '../expenses/schemas/expense.schema';
import { EventsService } from '../notifications/events.service';
import { Room } from '../rooms/schemas/room.schema';
import { User } from '../users/schemas/user.schema';
import { CloseBusinessDayDto, StartBusinessDayDto } from './dto/daybook.dto';
import { BusinessDayStatus, DayBook, DayBookDocument } from './schemas/day-book.schema';

/** Source of an entry; entries from before sources are inferred from what they hold. */
export function sourceOf(entry: { source?: EntrySource | null; stayId?: unknown; type?: string }): EntrySource {
  if (entry.source) return entry.source;
  if (entry.stayId) return entry.type === 'Refund' ? EntrySource.REFUND : EntrySource.STAY_PAYMENT;
  if (entry.type === 'Restaurant') return EntrySource.RESTAURANT;
  return EntrySource.MANUAL;
}

const statusOf = (d: { status?: BusinessDayStatus | null; closedAt?: Date | null } | null) =>
  d ? (d.status ?? (d.closedAt ? BusinessDayStatus.CLOSED : null)) : null;

@Injectable()
export class DaybookService {
  constructor(
    @InjectModel(DayBook.name) private readonly books: Model<DayBook>,
    @InjectModel(CashTxn.name) private readonly cash: Model<CashTxn>,
    @InjectModel(DayRegisterEntry.name) private readonly entries: Model<DayRegisterEntry>,
    @InjectModel(Expense.name) private readonly expenses: Model<Expense>,
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly tx: TransactionService,
    private readonly dates: BusinessDateService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every new money posting goes to the open business day, whatever date the
   * app sent. Writing to the day's document makes a posting and a close
   * running together conflict instead of interleaving.
   */
  async requireOpenDay(session: ClientSession): Promise<string> {
    const day = await this.books.findOneAndUpdate(
      { status: BusinessDayStatus.OPEN },
      { $inc: { rev: 1 } },
      { new: true, session },
    );
    if (!day) throw conflict('DAY_NOT_OPEN', 'No business day is open. Start the day first.');
    return day.businessDate;
  }

  /** Edits and deletes are allowed only on the open day. */
  async assertEditable(date: string, session: ClientSession): Promise<void> {
    const day = await this.books.findOneAndUpdate({ businessDate: date }, { $inc: { rev: 1 } }, { new: true, session });
    const status = statusOf(day);
    if (status === BusinessDayStatus.CLOSED) throw conflict('DAY_CLOSED', `${date} is closed and can't be changed`);
    if (status !== BusinessDayStatus.OPEN) throw conflict('DAY_NOT_OPEN', `${date} is not the open business day`);
  }

  /** The open day's date, or null; for defaults that aren't money postings. */
  async openDate(): Promise<string | null> {
    return (await this.books.findOne({ status: BusinessDayStatus.OPEN }).select('businessDate').lean())?.businessDate ?? null;
  }

  async current() {
    const open = await this.books.findOne({ status: BusinessDayStatus.OPEN }).lean();
    const last = await this.lastClosed();
    const names = await this.namesOf([open?.openedByUserId]);
    return {
      status: open ? BusinessDayStatus.OPEN : last ? BusinessDayStatus.CLOSED : 'NONE',
      businessDate: open?.businessDate ?? null,
      openedAt: open?.openedAt ?? null,
      openedByName: open ? (names.get(String(open.openedByUserId)) ?? null) : null,
      openingBalance: open?.openingBalance ?? null,
      lastClosingBalance: last?.closingBalance ?? null,
      lastClosedDate: last?.businessDate ?? null,
      suggestedNextDate: last ? this.dates.addDays(last.businessDate, 1) : this.dates.today(),
    };
  }

  start(dto: StartBusinessDayDto, user: Principal) {
    if (!this.dates.isRealDate(dto.businessDate)) throw badRequest('INVALID_DATE', 'Business date must be a real date');
    const work = () =>
      this.tx.run(async ({ session, afterCommit }) => {
        if (await this.books.exists({ status: BusinessDayStatus.OPEN }).session(session)) {
          throw conflict('DAY_ALREADY_OPEN', 'A business day is already open. Close it first.');
        }
        const existing = await this.books.findOne({ businessDate: dto.businessDate }).session(session).lean();
        if (statusOf(existing) === BusinessDayStatus.CLOSED) {
          throw conflict('DAY_ALREADY_CLOSED', `${dto.businessDate} has already been closed; only the owner can reopen it`);
        }
        const last = await this.lastClosed(session);
        const opening = dec(dto.openingBalance);
        const differs = last ? !opening.equals(dec(last.closingBalance)) : false;
        if (differs && !dto.note?.trim()) {
          throw badRequest('NOTE_REQUIRED', `Opening balance differs from the last closing balance (${dec(last!.closingBalance).toFixed(2)}); add a note`);
        }
        const day = await this.books.findOneAndUpdate(
          { businessDate: dto.businessDate },
          {
            $set: {
              status: BusinessDayStatus.OPEN,
              openingBalance: toD128(opening),
              openedAt: new Date(),
              openedByUserId: userObjectId(user),
              openedTime: dto.time,
              startNote: dto.note?.trim() ?? '',
              closingBalance: null,
              closedAt: null,
              closedByUserId: null,
              closedTime: null,
              expectedCash: null,
              countedCash: null,
              shortage: null,
              closeNote: '',
            },
            $inc: { rev: 1 },
          },
          { upsert: true, new: true, session, setDefaultsOnInsert: true },
        );
        await this.audit.record(
          AuditAction.DAY_START,
          null,
          userObjectId(user),
          { openingBalance: day.openingBalance, lastClosingBalance: last?.closingBalance ?? null, note: day.startNote, time: dto.time },
          session,
          dto.businessDate,
        );
        afterCommit(() => this.events.toHotel('daybook.closed', { businessDate: dto.businessDate, status: 'OPEN' }));
        return day;
      });
    return this.withOneOpenGuard(work).then((day) => this.view(day));
  }

  /**
   * closingBalance = opening + credits − debits (all modes);
   * expectedCash = opening + net CASH movements; shortage = expected − counted.
   */
  close(dto: Partial<CloseBusinessDayDto> & { businessDate?: string }, user: Principal) {
    return this.tx
      .run(async ({ session, afterCommit }) => {
        const day = await this.books.findOneAndUpdate(
          { status: BusinessDayStatus.OPEN },
          { $inc: { rev: 1 } },
          { new: true, session },
        );
        if (!day) {
          const named = dto.businessDate ? await this.books.findOne({ businessDate: dto.businessDate }).session(session).lean() : null;
          if (statusOf(named) === BusinessDayStatus.CLOSED) throw conflict('DAY_ALREADY_CLOSED', `${dto.businessDate} is already closed`);
          throw conflict('DAY_NOT_OPEN', 'No business day is open');
        }
        if (dto.businessDate && dto.businessDate !== day.businessDate) {
          throw conflict('DAY_MISMATCH', `The open business day is ${day.businessDate}, not ${dto.businessDate}`);
        }
        const all = await this.totals(day.businessDate, session);
        const cashOnly = await this.totals(day.businessDate, session, PaymentMode.CASH);
        const opening = dec(day.openingBalance);
        const expected = opening.plus(cashOnly.credits).minus(cashOnly.debits);
        day.closingBalance = toD128(opening.plus(all.credits).minus(all.debits));
        day.expectedCash = toD128(expected);
        if (dto.countedCash !== undefined) {
          const shortage = expected.minus(dec(dto.countedCash));
          if (!shortage.isZero() && !dto.note?.trim()) {
            throw badRequest(
              'NOTE_REQUIRED',
              `Counted cash is ${shortage.gt(0) ? 'short' : 'over'} by ${shortage.abs().toFixed(2)}; add a note`,
            );
          }
          day.countedCash = toD128(dto.countedCash);
          day.shortage = toD128(shortage);
          day.closeNote = dto.note?.trim() ?? '';
        }
        day.status = BusinessDayStatus.CLOSED;
        day.closedAt = new Date();
        day.closedByUserId = userObjectId(user);
        day.closedTime = dto.time ?? this.dates.nowTime();
        await day.save({ session });
        await this.audit.record(
          AuditAction.DAY_CLOSE,
          null,
          userObjectId(user),
          {
            closingBalance: day.closingBalance,
            expectedCash: day.expectedCash,
            countedCash: day.countedCash,
            shortage: day.shortage,
            note: day.closeNote,
            time: day.closedTime,
          },
          session,
          day.businessDate,
        );
        afterCommit(() => this.events.toHotel('daybook.closed', { businessDate: day.businessDate, status: 'CLOSED' }));
        return day;
      })
      .then((day) => this.view(day));
  }

  /** OWNER only: reopen a closed day, provided no other day is open. */
  reopen(date: string, note: string, user: Principal) {
    const work = () =>
      this.tx.run(async ({ session }) => {
        if (await this.books.exists({ status: BusinessDayStatus.OPEN }).session(session)) {
          throw conflict('DAY_ALREADY_OPEN', 'Another business day is open. Close it first.');
        }
        const day = await this.books.findOne({ businessDate: date }).session(session);
        if (!day) throw notFound('Business day');
        if (statusOf(day) !== BusinessDayStatus.CLOSED) throw conflict('DAY_NOT_CLOSED', `${date} is not closed`);
        const before = { closingBalance: day.closingBalance, countedCash: day.countedCash, shortage: day.shortage };
        Object.assign(day, {
          status: BusinessDayStatus.OPEN,
          closingBalance: null,
          closedAt: null,
          closedByUserId: null,
          closedTime: null,
          expectedCash: null,
          countedCash: null,
          shortage: null,
          closeNote: '',
        });
        day.rev += 1;
        await day.save({ session });
        await this.audit.record(AuditAction.DAY_REOPEN, null, userObjectId(user), { before, note }, session, date);
        return day;
      });
    return this.withOneOpenGuard(work).then((day) => this.view(day));
  }

  /** Editable only while that day is open. */
  setOpening(date: string, amount: string, user: Principal, note?: string) {
    return this.tx
      .run(async ({ session }) => {
        await this.assertEditable(date, session);
        const day = await this.books.findOne({ businessDate: date }).session(session);
        const before = day!.openingBalance;
        day!.openingBalance = toD128(amount);
        await day!.save({ session });
        await this.audit.record(
          AuditAction.OPENING_BALANCE_CHANGE,
          null,
          userObjectId(user),
          { from: before, to: day!.openingBalance, note: note ?? '' },
          session,
          date,
        );
        return day!;
      })
      .then((day) => this.view(day));
  }

  /** The legacy day book view for a date, plus the business-day fields. */
  async get(date: string) {
    const day = await this.books.findOne({ businessDate: date }).lean();
    const { credits, debits } = await this.totals(date);
    const opening = day ? dec(day.openingBalance) : dec(await this.carriedOpening(date));
    const status = statusOf(day);
    const names = await this.namesOf([day?.openedByUserId, day?.closedByUserId]);
    return {
      id: day?._id ?? null,
      businessDate: date,
      status: status ?? 'NONE',
      openingBalance: toD128(opening),
      credits: toD128(credits),
      debits: toD128(debits),
      // Live figure until closed, then the recorded one.
      closingBalance: status === BusinessDayStatus.CLOSED && day?.closingBalance ? day.closingBalance : toD128(opening.plus(credits).minus(debits)),
      openedAt: day?.openedAt ?? null,
      openedByName: day?.openedByUserId ? (names.get(String(day.openedByUserId)) ?? null) : null,
      closedAt: day?.closedAt ?? null,
      closedByUserId: day?.closedByUserId ?? null,
      closedByName: day?.closedByUserId ? (names.get(String(day.closedByUserId)) ?? null) : null,
      expectedCash: day?.expectedCash ?? null,
      countedCash: day?.countedCash ?? null,
      shortage: day?.shortage ?? null,
      closeNote: day?.closeNote ?? '',
      startNote: day?.startNote ?? '',
    };
  }

  /** Every money line of a business day, in time order. Its totals equal /daybook's. */
  async register(date: string) {
    const [entries, expenses] = await Promise.all([
      this.entries.find({ businessDate: date }).lean(),
      this.expenses.find({ businessDate: date }).lean(),
    ]);
    const rooms = await this.rooms.find({ _id: { $in: entries.map((e) => e.roomId).filter(Boolean) } }).select('number').lean();
    const numberOf = new Map(rooms.map((r) => [String(r._id), r.number]));
    const lines = [
      ...entries.map((e) => ({
        id: e._id,
        kind: 'entry' as const,
        source: sourceOf(e),
        time: e.time,
        roomNumber: e.roomId ? (numberOf.get(String(e.roomId)) ?? null) : null,
        guestName: e.guestName,
        phone: e.phone,
        vehicle: e.vehicle,
        type: e.type,
        mode: e.mode,
        dc: e.dc,
        amount: e.amount,
        narration: e.narration,
        shortfall: e.shortfall ?? null,
        createdAt: (e as any).createdAt,
      })),
      ...expenses.map((x) => ({
        id: x._id,
        kind: 'expense' as const,
        source: 'EXPENSE',
        time: x.time ?? '',
        roomNumber: null,
        guestName: x.vendor,
        phone: null,
        vehicle: null,
        type: x.head,
        mode: x.mode,
        dc: DebitCredit.DEBIT,
        amount: x.amount,
        narration: x.narration,
        shortfall: null,
        createdAt: (x as any).createdAt,
      })),
    ];
    lines.sort((a, b) => (a.time || '').localeCompare(b.time || '') || +new Date(a.createdAt) - +new Date(b.createdAt));
    return lines.map(({ createdAt: _c, ...line }) => line);
  }

  /** Days closed with a cash difference, and checkouts that left money unpaid. */
  async shortages(from: string, to: string) {
    if (to < from) throw badRequest('INVALID_RANGE', '`to` must not be before `from`');
    const [days, entries] = await Promise.all([
      this.books
        .find({ businessDate: { $gte: from, $lte: to }, shortage: { $nin: [null, Types.Decimal128.fromString('0')] } })
        .sort({ businessDate: 1 })
        .lean(),
      this.entries.find({ businessDate: { $gte: from, $lte: to }, shortfall: { $gt: Types.Decimal128.fromString('0') } }).sort({ businessDate: 1, time: 1 }).lean(),
    ]);
    const rooms = await this.rooms.find({ _id: { $in: entries.map((e) => e.roomId).filter(Boolean) } }).select('number').lean();
    const numberOf = new Map(rooms.map((r) => [String(r._id), r.number]));
    return {
      days: days.map((d) => ({
        businessDate: d.businessDate,
        expectedCash: d.expectedCash,
        countedCash: d.countedCash,
        shortage: d.shortage,
        closeNote: d.closeNote,
        closedAt: d.closedAt,
      })),
      entries: entries.map((e) => ({
        id: e._id,
        businessDate: e.businessDate,
        time: e.time,
        roomNumber: e.roomId ? (numberOf.get(String(e.roomId)) ?? null) : null,
        stayId: e.stayId,
        guestName: e.guestName,
        phone: e.phone,
        amount: e.amount,
        shortfall: e.shortfall,
        narration: e.narration,
      })),
    };
  }

  async view(day: DayBookDocument | (DayBook & { _id: unknown })) {
    const names = await this.namesOf([day.openedByUserId, day.closedByUserId]);
    return {
      id: day._id,
      businessDate: day.businessDate,
      status: statusOf(day),
      openedAt: day.openedAt,
      openedTime: day.openedTime,
      openedByUserId: day.openedByUserId,
      openedByName: day.openedByUserId ? (names.get(String(day.openedByUserId)) ?? null) : null,
      openingBalance: day.openingBalance,
      startNote: day.startNote,
      closedAt: day.closedAt,
      closedTime: day.closedTime,
      closedByUserId: day.closedByUserId,
      closedByName: day.closedByUserId ? (names.get(String(day.closedByUserId)) ?? null) : null,
      expectedCash: day.expectedCash,
      countedCash: day.countedCash,
      shortage: day.shortage,
      closeNote: day.closeNote,
      closingBalance: day.closingBalance,
    };
  }

  private async withOneOpenGuard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err: any) {
      // The unique index on OPEN catches two starts racing each other.
      if (err?.code === 11000 && String(err.message).includes('one_open_day')) {
        throw conflict('DAY_ALREADY_OPEN', 'A business day is already open. Close it first.');
      }
      throw err;
    }
  }

  private async totals(date: string, session?: ClientSession, mode?: PaymentMode): Promise<{ credits: Decimal; debits: Decimal }> {
    const rows = await this.cash
      .aggregate<{ _id: DebitCredit; total: Types.Decimal128 }>([
        { $match: { businessDate: date, ...(mode ? { mode } : {}) } },
        { $group: { _id: '$dc', total: { $sum: '$amount' } } },
      ])
      .session(session ?? null);
    const of = (dc: DebitCredit) => dec(rows.find((r) => r._id === dc)?.total);
    return { credits: of(DebitCredit.CREDIT), debits: of(DebitCredit.DEBIT) };
  }

  private lastClosed(session?: ClientSession) {
    return this.books.findOne({ closedAt: { $ne: null } }).sort({ closedAt: -1 }).session(session ?? null).lean();
  }

  /** Opening for a date with no document yet: the latest earlier closed balance. */
  private async carriedOpening(date: string): Promise<Types.Decimal128> {
    const prior = await this.books.findOne({ businessDate: { $lt: date }, closedAt: { $ne: null } }).sort({ businessDate: -1 }).lean();
    return prior?.closingBalance ?? toD128('0');
  }

  private async namesOf(ids: (Types.ObjectId | null | undefined)[]) {
    const wanted = ids.filter(Boolean).map(String);
    if (!wanted.length) return new Map<string, string>();
    const users = await this.users.find({ _id: { $in: wanted } }).select('name').lean();
    return new Map(users.map((u) => [String(u._id), u.name]));
  }
}
