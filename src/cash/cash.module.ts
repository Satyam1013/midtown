import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashTxn, CashTxnSchema } from './schemas/cash-txn.schema';

// Phase 1: model registration only. Controller and service come next phase.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CashTxn.name, schema: CashTxnSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class CashModule {}
