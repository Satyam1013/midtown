import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OnlineOrder, OnlineOrderSchema } from './schemas/online-order.schema';

// Phase 1: model registration only. Controller and service come next phase.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class OnlineOrdersModule {}
