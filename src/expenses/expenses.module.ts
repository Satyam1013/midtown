import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Expense, ExpenseSchema } from './schemas/expense.schema';

// Phase 1: model registration only. Controller and service come next phase.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Expense.name, schema: ExpenseSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class ExpensesModule {}
