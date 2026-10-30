import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StockItem, StockItemSchema } from './schemas/stock-item.schema';
import { StockMovement, StockMovementSchema } from './schemas/stock-movement.schema';

// Phase 1: model registration only. Controller and service come next phase.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: StockItem.name, schema: StockItemSchema },
      { name: StockMovement.name, schema: StockMovementSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class StockModule {}
