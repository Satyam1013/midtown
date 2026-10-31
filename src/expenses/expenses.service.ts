import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CashTxn } from '../cash-transactions/schemas/cash-txn.schema';
import { DateQueryDto, pageOf } from '../common/dto/common.dto';
import { DebitCredit } from '../common/enums';
import { Paged } from '../common/interceptors/response.interceptor';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { BusinessDateService } from '../common/services/business-date.service';
import { toD128 } from '../common/utils/money';
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
      this.expenses.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.expenses.countDocuments(filter),
    ]);
    return new Paged(items, { page, limit, total });
  }

  /** Expense and its DEBIT cash line, together or not at all. */
  create(dto: CreateExpenseDto, user: Principal) {
    this.dates.assertAllowed(dto.businessDate, user);
    return this.tx.run(async ({ session }) => {
      await this.daybook.touchOpenDay(dto.businessDate, user, session);
      const amount = toD128(dto.amount);
      const [expense] = await this.expenses.create([{ ...dto, amount, createdByUserId: userObjectId(user) }], { session });
      const [txn] = await this.cash.create(
        [
          {
            businessDate: dto.businessDate,
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
