import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RoomType, RoomTypeSchema } from './schemas/room-type.schema';

// Phase 1: model registration only. Controller and service come next phase.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RoomType.name, schema: RoomTypeSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class RoomTypesModule {}
