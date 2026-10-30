import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Room, RoomSchema } from './schemas/room.schema';

// Phase 1: model registration only. Controller and service come next phase.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Room.name, schema: RoomSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class RoomsModule {}
