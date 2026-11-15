import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, ref } from '../../database/build-schema';

// One maintenance period of a room; open while endedAt is null.
@Schema({ collection: 'room_maintenance', timestamps: true })
export class RoomMaintenance {
  @Prop(ref('Room'))
  roomId: Types.ObjectId;

  @Prop({ type: String, default: '' })
  reason: string;

  @Prop({ type: String, default: null })
  expectedBackDate: string | null;

  @Prop({ type: Date, required: true })
  startedAt: Date;

  @Prop(ref('User'))
  startedByUserId: Types.ObjectId;

  @Prop({ type: Date, default: null })
  endedAt: Date | null;

  @Prop(ref('User', { required: false }))
  endedByUserId: Types.ObjectId | null;

  /** The status the room moved to when maintenance ended. */
  @Prop({ type: String, default: null })
  endedTo: string | null;
}

export type RoomMaintenanceDocument = HydratedDocument<RoomMaintenance>;
export const RoomMaintenanceSchema = buildSchema(RoomMaintenance);
RoomMaintenanceSchema.index({ roomId: 1, startedAt: -1 });
