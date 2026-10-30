import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DayRegisterEntry, DayRegisterEntrySchema } from './schemas/day-register-entry.schema';

// Phase 1: model registration only. Controller and service come next phase.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DayRegisterEntry.name, schema: DayRegisterEntrySchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class EntriesModule {}
