import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, money, ref } from '../../database/build-schema';

export enum RoomStatus {
  VACANT = 'VACANT',
  OCCUPIED = 'OCCUPIED',
  DIRTY = 'DIRTY',
  OOO = 'OOO',
}

@Schema({ collection: 'rooms', timestamps: true })
export class Room {
  @Prop({ required: true, trim: true })
  number: string;

  @Prop({ required: true, min: 0 })
  floor: number;

  @Prop(ref('RoomType'))
  roomTypeId: Types.ObjectId;

  // Derived from stays (check-in → OCCUPIED, check-out → DIRTY,
  // housekeeping → VACANT). OOO is the only manual status.
  @Prop({ type: String, enum: Object.values(RoomStatus), default: RoomStatus.VACANT })
  status: RoomStatus;

  /** Default nightly rate for this room; a stay snapshots its own rate. */
  @Prop(money())
  rate: Types.Decimal128;
}

export type RoomDocument = HydratedDocument<Room>;
export const RoomSchema = buildSchema(Room);

// Unique across soft-deleted rooms too: a room number is never reused for
// a different physical room, and historical stays point at it.
RoomSchema.index({ number: 1 }, { unique: true });
RoomSchema.index({ floor: 1, number: 1 });
RoomSchema.index({ status: 1 });
RoomSchema.index({ roomTypeId: 1 });
