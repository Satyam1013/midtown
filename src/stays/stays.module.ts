import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Stay, StaySchema } from './schemas/stay.schema';

// Phase 1: model registration only. Controller and service come next phase.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Stay.name, schema: StaySchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class StaysModule {}
