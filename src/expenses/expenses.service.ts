import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { CashTxn } from '../cash-transactions/schemas/cash-txn.schema';
import { pageOf } from '../common/dto/common.dto';
import { DebitCredit } from '../common/enums';
import { Paged } from '../common/interceptors/response.interceptor';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { BusinessDateService } from '../common/services/business-date.service';
import { dec, sum, toD128 } from '../common/utils/money';
import { TransactionService } from '../database/transaction.service';
import { DaybookService } from '../daybook/daybook.service';
import { CreateExpenseDto, ExpenseListQueryDto, ExpensePaymentDto, UpdateExpenseDto } from './dto/expense.dto';
import { Staff } from '../staff/schemas/staff.schema';
import { LedgerService } from '../entries/ledger.service';
import { EntrySource } from '../entries/schemas/day-register-entry.schema';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { EventsService } from '../notifications/events.service';
import { badRequest, conflict, notFound } from '../common/errors';
import { Expense } from './schemas/expense.schema';

/** The head the app sends for an advance against a staff member's salary. */
export const SALARY_ADVANCE = 'Salary advance';
const isAdvance = (head: string | undefined | null) => (head ?? '').trim().toLowerCase() === SALARY_ADVANCE.toLowerCase();

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
    @InjectModel(Staff.name) private readonly staff: Model<Staff>,
  ) {}

  /** A salary advance names an existing staff member and is paid now; any staffId sent must exist. */
  private async assertStaff(head: string, staffId: string | Types.ObjectId | null | undefined, onCredit: boolean, session?: ClientSession) {
    if (isAdvance(head)) {
      if (!staffId) throw badRequest('STAFF_REQUIRED', 'Choose the staff member for a salary advance');
      if (onCredit) throw badRequest('ADVANCE_ON_CREDIT', 'A salary advance is paid now, not on credit');
    }
    if (staffId && !(await this.staff.exists({ _id: staffId }).session(session ?? null))) throw badRequest('STAFF_NOT_FOUND', 'That staff member does not exist');
  }

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
  async create(dto: CreateExpenseDto, user: Principal) {
    await this.assertStaff(dto.head, dto.staffId, !!dto.onCredit);
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

  /**
   * ADMIN: correct an expense of the open day. A paid-now expense's cash line is
   * rewritten with it in one transaction, so the day book moves by exactly the
   * difference. A closed day is never edited: 409 DAY_CLOSED.
   */
  async update(id: Types.ObjectId, dto: UpdateExpenseDto, user: Principal) {
    const expense = await this.tx.run(async ({ session }) => {
      const e = await this.expenses.findById(id).session(session);
      if (!e) throw notFound('Expense');
      await this.daybook.assertEditable(e.businessDate, session);
      if (dto.onCredit !== undefined && dto.onCredit !== !!e.onCredit) {
        throw badRequest('ON_CREDIT_LOCKED', 'An expense can’t be switched between paid now and on credit; delete it and add it again');
      }
      const before = e.toObject();
      const head = dto.head?.trim() ?? e.head;
      const staffId = dto.staffId === undefined ? e.staffId : dto.staffId;
      await this.assertStaff(head, staffId, !!e.onCredit, session);

      if (e.onCredit) {
        if (dto.mode) throw badRequest('MODE_NOT_ALLOWED', 'An expense on credit has no payment mode');
        if (dto.amount !== undefined) {
          const paid = dec(e.paidAmount ?? 0);
          if (dec(dto.amount).lt(paid)) {
            throw conflict('EXPENSE_PAYMENTS_EXIST', `${paid.toFixed(2)} has already been paid on this expense; the amount can’t go below that`);
          }
          e.amount = toD128(dto.amount);
          e.dueAmount = toD128(dec(dto.amount).minus(paid));
        }
        if (dto.dueDate !== undefined) e.dueDate = dto.dueDate;
      } else {
        if (dto.dueDate) throw badRequest('DUE_DATE_NOT_ALLOWED', 'Only an expense on credit has a due date');
        if (dto.amount !== undefined) {
          e.amount = toD128(dto.amount);
          e.paidAmount = e.amount;
        }
        if (dto.mode) e.mode = dto.mode;
      }
      e.head = head;
      if (dto.vendor !== undefined) e.vendor = dto.vendor.trim();
      if (dto.narration !== undefined) e.narration = dto.narration;
      e.staffId = staffId ? new Types.ObjectId(String(staffId)) : null;
      if (e.onCredit && !e.vendor?.trim()) throw badRequest('VENDOR_REQUIRED', 'Name the vendor for an expense on credit');
      await e.save({ session });

      if (!e.onCredit && e.txnId) {
        await this.cash.updateOne(
          { _id: e.txnId },
          { $set: { head: e.head, mode: e.mode, amount: e.amount, narration: e.narration || e.vendor || e.head } },
          { session },
        );
      }
      const changed = Object.fromEntries(
        ['head', 'vendor', 'staffId', 'amount', 'narration', 'mode', 'dueDate']
          .filter((k) => String((before as any)[k] ?? '') !== String((e as any)[k] ?? ''))
          .map((k) => [k, { from: (before as any)[k] ?? null, to: (e as any)[k] ?? null }]),
      );
      await this.audit.record(AuditAction.EXPENSE_UPDATE, null, userObjectId(user), { expenseId: String(id), changed }, session, e.businessDate);
      return e;
    });
    this.events.toHotel('expense.updated', { id: String(id), businessDate: expense.businessDate });
    return this.expenses.findById(id).lean();
  }

  /**
   * ADMIN: soft-deletes an expense of the open day with its cash line, so the day
   * book, register and reports drop it together. A credit expense with payments
   * is refused (409 EXPENSE_PAYMENTS_EXIST): those payments are day-book lines,
   * possibly on other days, and are left for the owner to deal with.
   */
  async remove(id: Types.ObjectId, user: Principal) {
    const expense = await this.tx.run(async ({ session }) => {
      const e = await this.expenses.findById(id).session(session);
      if (!e) throw notFound('Expense');
      await this.daybook.assertEditable(e.businessDate, session);
      if (e.onCredit && (dec(e.paidAmount ?? 0).gt(0) || e.payments.length)) {
        throw conflict('EXPENSE_PAYMENTS_EXIST', 'Payments have been made on this expense; it can’t be deleted');
      }
      const now = new Date();
      if (e.txnId) await this.cash.updateOne({ _id: e.txnId }, { $set: { deletedAt: now } }, { session });
      await this.cash.updateMany({ expenseId: e._id }, { $set: { deletedAt: now } }, { session });
      e.set({ deletedAt: now, deletedByUserId: userObjectId(user) });
      await e.save({ session });
      await this.audit.record(
        AuditAction.EXPENSE_DELETE,
        null,
        userObjectId(user),
        { expenseId: String(id), before: { head: e.head, vendor: e.vendor, staffId: e.staffId, amount: e.amount, mode: e.mode, onCredit: e.onCredit, narration: e.narration, time: e.time } },
        session,
        e.businessDate,
      );
      return e;
    });
    this.events.toHotel('expense.updated', { id: String(id), businessDate: expense.businessDate, deleted: true });
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
