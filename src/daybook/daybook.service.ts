import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import Decimal from 'decimal.js';
import { ClientSession, Model, Types } from 'mongoose';
import { CashTxn } from '../cash-transactions/schemas/cash-txn.schema';
import { DebitCredit, Role } from '../common/enums';
import { conflict } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { BusinessDateService } from '../common/services/business-date.service';
import { dec, toD128 } from '../common/utils/money';
import { TransactionService } from '../database/transaction.service';
import { EventsService } from '../notifications/events.service';
import { DayBook } from './schemas/day-book.schema';

@Injectable()
export class DaybookService {
  constructor(
    @InjectModel(DayBook.name) private readonly books: Model<DayBook>,
    @InjectModel(CashTxn.name) private readonly cash: Model<CashTxn>,
    private readonly tx: TransactionService,
    private readonly dates: BusinessDateService,
    private readonly events: EventsService,
  ) {}

  /**
   * Called by every transaction that posts money to a date. Writing to the
   * day's document makes the post conflict with a simultaneous close, so
   * neither can miss the other. A closed day rejects everyone except OWNER.
   */
  async touchOpenDay(date: string, user: Principal, session: ClientSession): Promise<void> {
    const opening = await this.carriedOpening(date, session);
    const book = await this.books.findOneAndUpdate(
      { businessDate: date },
      { $inc: { rev: 1 }, $setOnInsert: { openingBalance: opening } },
      { upsert: true, new: true, session, setDefaultsOnInsert: true },
    );
    if (book.closedAt && user.role !== Role.OWNER) {
      throw conflict('DAY_CLOSED', `${date} is closed; only the owner can change it`);
    }
  }

  async get(date: string) {
    const book = await this.books.findOne({ businessDate: date }).lean();
    const { credits, debits } = await this.totals(date);
    const opening = book ? dec(book.openingBalance) : dec(await this.carriedOpening(date));
    return {
      id: book?._id ?? null,
      businessDate: date,
      openingBalance: toD128(opening),
      credits: toD128(credits),
      debits: toD128(debits),
      // Live figure until closed, then the recorded one.
      closingBalance: book?.closedAt ? book.closingBalance : toD128(opening.plus(credits).minus(debits)),
      closedAt: book?.closedAt ?? null,
      closedByUserId: book?.closedByUserId ?? null,
    };
  }

  async setOpening(date: string, amount: string, user: Principal) {
    this.dates.assertAllowed(date, user);
    return this.tx.run(async ({ session }) => {
      await this.touchOpenDay(date, user, session);
      return this.books.findOneAndUpdate(
        { businessDate: date },
        { $set: { openingBalance: toD128(amount) } },
        { new: true, session },
      );
    });
  }

  /** closing = opening + credits − debits, from live CashTxn documents. */
  async close(date: string, user: Principal) {
    this.dates.assertAllowed(date, user);
    return this.tx.run(async ({ session, afterCommit }) => {
      const opening = await this.carriedOpening(date, session);
      const book = await this.books.findOneAndUpdate(
        { businessDate: date },
        { $inc: { rev: 1 }, $setOnInsert: { openingBalance: opening } },
        { upsert: true, new: true, session, setDefaultsOnInsert: true },
      );
      if (book.closedAt) throw conflict('DAY_ALREADY_CLOSED', `${date} is already closed`);

      const { credits, debits } = await this.totals(date, session);
      const closing = toD128(dec(book.openingBalance).plus(credits).minus(debits));
      book.closingBalance = closing;
      book.closedAt = new Date();
      book.closedByUserId = userObjectId(user);
      await book.save({ session });

      // Carry forward, unless the next day has itself already been closed.
      const next = this.dates.addDays(date, 1);
      await this.books.updateOne(
        { businessDate: next, closedAt: null },
        { $set: { openingBalance: closing }, $inc: { rev: 1 } },
        { upsert: !(await this.books.exists({ businessDate: next }).session(session)), session, setDefaultsOnInsert: true },
      );

      afterCommit(() => this.events.toHotel('daybook.closed', { businessDate: date }));
      return book;
    });
  }

  private async totals(date: string, session?: ClientSession): Promise<{ credits: Decimal; debits: Decimal }> {
    const rows = await this.cash
      .aggregate<{ _id: DebitCredit; total: Types.Decimal128 }>([
        { $match: { businessDate: date } },
        { $group: { _id: '$dc', total: { $sum: '$amount' } } },
      ])
      .session(session ?? null);
    const of = (dc: DebitCredit) => dec(rows.find((r) => r._id === dc)?.total);
    return { credits: of(DebitCredit.CREDIT), debits: of(DebitCredit.DEBIT) };
  }

  /** Opening for a day with no document yet: the latest earlier closed balance. */
  private async carriedOpening(date: string, session?: ClientSession): Promise<Types.Decimal128> {
    const prior = await this.books
      .findOne({ businessDate: { $lt: date }, closedAt: { $ne: null } })
      .sort({ businessDate: -1 })
      .session(session ?? null)
      .lean();
    return prior?.closingBalance ?? toD128('0');
  }
}
