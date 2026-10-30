import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DayBook, DayBookSchema } from './schemas/day-book.schema';

// Phase 1: model registration only. Controller and service come next phase.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DayBook.name, schema: DayBookSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class DaybookModule {}
