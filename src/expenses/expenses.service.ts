import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CashTxn } from '../cash-transactions/schemas/cash-txn.schema';
import { pageOf } from '../common/dto/common.dto';
import { DebitCredit } from '../common/enums';
import { Paged } from '../common/interceptors/response.interceptor';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { BusinessDateService } from '../common/services/business-date.service';
import { dec, sum, toD128 } from '../common/utils/money';
import { TransactionService } from '../database/transaction.service';
import { DaybookService } from '../daybook/daybook.service';
import { CreateExpenseDto, ExpenseListQueryDto, ExpensePaymentDto } from './dto/expense.dto';
import { LedgerService } from '../entries/ledger.service';
import { EntrySource } from '../entries/schemas/day-register-entry.schema';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { EventsService } from '../notifications/events.service';
import { badRequest, notFound } from '../common/errors';
import { Expense } from './schemas/expense.schema';

@Injectable()
export class ExpensesService {
  constructor(
    @InjectModel(Expense.name) private readonly expenses: Model<Expense>,
    @InjectModel(CashTxn.name) private readonly cash: Model<CashTxn>,
    private readonly tx: TransactionService,
    private readonly daybook: DaybookService,
    private readonly dates: BusinessDateService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  async list(q: ExpenseListQueryDto) {
    const { page, limit, skip } = pageOf(q);
    const filter: Record<string, unknown> = q.date ? { businessDate: q.date } : {};
    if (q.status === 'DUE') {
      filter.onCredit = true;
      filter.dueAmount = { $gt: Types.Decimal128.fromString('0') };
    }
    const sort: Record<string, 1 | -1> = q.status === 'DUE' ? { dueDate: 1, businessDate: 1, createdAt: 1 } : { time: 1, createdAt: 1 };
    const [items, total] = await Promise.all([
      this.expenses.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      this.expenses.countDocuments(filter),
    ]);
    return new Paged(items, { page, limit, total });
  }

  /** Totals for a business day, overall and per head. */
  async summary(date: string) {
    const rows = await this.expenses.aggregate<{ _id: string; total: Types.Decimal128; count: number }>([
      { $match: { businessDate: date } },
      { $group: { _id: '$head', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    return {
      businessDate: date,
      total: toD128(sum(rows.map((r) => r.total))),
      count: rows.reduce((n, r) => n + r.count, 0),
      byHead: rows.map((r) => ({ head: r._id, total: r.total, count: r.count })),
    };
  }

  /**
   * On the open business day. A cash expense writes its DEBIT cash line with it;
   * a credit expense (onCredit) is booked as an expense with nothing paid and moves no money.
   */
  create(dto: CreateExpenseDto, user: Principal) {
    if (dto.onCredit) return this.createOnCredit(dto, user);
    if (!dto.mode) throw badRequest('MODE_REQUIRED', 'Choose how the expense was paid');
    return this.tx.run(async ({ session }) => {
      const businessDate = await this.daybook.requireOpenDay(session);
      const amount = toD128(dto.amount);
      const { businessDate: _ignored, ...fields } = dto;
      const [expense] = await this.expenses.create(
        [{ ...fields, businessDate, time: dto.time ?? this.dates.nowTime(), amount, paidAmount: amount, dueAmount: toD128('0'), createdByUserId: userObjectId(user) }],
        { session },
      );
      const [txn] = await this.cash.create(
        [
          {
            businessDate,
            head: dto.head,
            mode: dto.mode,
            dc: DebitCredit.DEBIT,
            amount,
            narration: dto.narration || dto.vendor || dto.head,
            expenseId: expense._id,
          },
        ],
        { session },
      );
      expense.txnId = txn._id;
      await expense.save({ session });
      return expense;
    });
  }

  private createOnCredit(dto: CreateExpenseDto, user: Principal) {
    if (!dto.vendor?.trim()) throw badRequest('VENDOR_REQUIRED', 'Name the vendor for an expense on credit');
    if (dto.mode) throw badRequest('MODE_NOT_ALLOWED', 'An expense on credit has no payment mode; record payments as they are made');
    return this.tx.run(async ({ session }) => {
      const businessDate = await this.daybook.requireOpenDay(session);
      const amount = toD128(dto.amount);
      const { businessDate: _ignored, mode: _mode, ...fields } = dto;
      const [expense] = await this.expenses.create(
        [
          {
            ...fields,
            vendor: dto.vendor!.trim(),
            businessDate,
            time: dto.time ?? this.dates.nowTime(),
            amount,
            mode: null,
            onCredit: true,
            dueDate: dto.dueDate ?? null,
            paidAmount: toD128('0'),
            dueAmount: amount,
            createdByUserId: userObjectId(user),
          },
        ],
        { session },
      );
      await this.audit.record(AuditAction.EXPENSE_CREDIT, null, userObjectId(user), { expenseId: expense._id, vendor: expense.vendor, amount, dueDate: expense.dueDate }, session, businessDate);
      return expense;
    });
  }

  /** Pays (part of) a credit expense: a DEBIT day-book line on the open business day. */
  pay(id: Types.ObjectId, dto: ExpensePaymentDto, user: Principal) {
    return this.tx.run(async ({ session, afterCommit }) => {
      const businessDate = await this.daybook.requireOpenDay(session);
      const amount = toD128(dto.amount);
      const time = dto.time ?? this.dates.nowTime();
      // Conditional, so two payments at once can't overpay.
      const expense = await this.expenses.findOneAndUpdate(
        { _id: id, onCredit: true, dueAmount: { $gte: amount } },
        { $inc: { paidAmount: amount, dueAmount: toD128(dec(dto.amount).negated()) } },
        { new: true, session },
      );
      if (!expense) {
        const e = await this.expenses.findById(id).session(session).lean();
        if (!e) throw notFound('Expense');
        if (!e.onCredit) throw badRequest('NOT_ON_CREDIT', 'This expense was paid when it was made');
        throw badRequest('PAYMENT_TOO_HIGH', `Only ${dec(e.dueAmount).toFixed(2)} is due on this expense`);
      }
      const entry = await this.ledger.post(
        {
          businessDate,
          time,
          guestName: expense.vendor,
          type: `Expense payment: ${expense.head}`,
          mode: dto.mode,
          dc: DebitCredit.DEBIT,
          amount: dec(dto.amount).toFixed(2),
          narration: dto.narration?.trim() || `Paid ${expense.vendor} for ${expense.head} (${expense.businessDate})`,
          source: EntrySource.EXPENSE_PAYMENT,
          createdByUserId: userObjectId(user),
        },
        session,
      );
      expense.payments.push({ entryId: entry._id, amount, mode: dto.mode, businessDate, time, userId: userObjectId(user), paidAt: new Date() });
      await expense.save({ session });
      await this.audit.record(AuditAction.EXPENSE_PAYMENT, null, userObjectId(user), { expenseId: id, vendor: expense.vendor, amount, mode: dto.mode, dueAfter: expense.dueAmount, entryId: entry._id }, session, businessDate);
      afterCommit(() => this.events.toHotel('entry.created', { id: String(entry._id), businessDate }));
      return { expense, entry };
    });
  }
}
