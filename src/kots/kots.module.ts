import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Kot, KotSchema } from './schemas/kot.schema';

// Phase 1: model registration only. Controller and service come next phase.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Kot.name, schema: KotSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class KotsModule {}
