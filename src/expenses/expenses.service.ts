import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CashTxn } from '../cash-transactions/schemas/cash-txn.schema';
import { DateQueryDto, pageOf } from '../common/dto/common.dto';
import { DebitCredit } from '../common/enums';
import { Paged } from '../common/interceptors/response.interceptor';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { BusinessDateService } from '../common/services/business-date.service';
import { sum, toD128 } from '../common/utils/money';
import { TransactionService } from '../database/transaction.service';
import { DaybookService } from '../daybook/daybook.service';
import { CreateExpenseDto } from './dto/expense.dto';
import { Expense } from './schemas/expense.schema';

@Injectable()
export class ExpensesService {
  constructor(
    @InjectModel(Expense.name) private readonly expenses: Model<Expense>,
    @InjectModel(CashTxn.name) private readonly cash: Model<CashTxn>,
    private readonly tx: TransactionService,
    private readonly daybook: DaybookService,
    private readonly dates: BusinessDateService,
  ) {}

  async list(q: DateQueryDto) {
    const { page, limit, skip } = pageOf(q);
    const filter = q.date ? { businessDate: q.date } : {};
    const [items, total] = await Promise.all([
      this.expenses.find(filter).sort({ time: 1, createdAt: 1 }).skip(skip).limit(limit).lean(),
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

  /** Expense and its DEBIT cash line, together or not at all, on the open business day. */
  create(dto: CreateExpenseDto, user: Principal) {
    return this.tx.run(async ({ session }) => {
      const businessDate = await this.daybook.requireOpenDay(session);
      const amount = toD128(dto.amount);
      const { businessDate: _ignored, ...fields } = dto;
      const [expense] = await this.expenses.create(
        [{ ...fields, businessDate, time: dto.time ?? this.dates.nowTime(), amount, createdByUserId: userObjectId(user) }],
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
}
