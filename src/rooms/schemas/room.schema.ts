import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, money, ref } from '../../database/build-schema';

export enum RoomStatus {
  VACANT = 'VACANT',
  OCCUPIED = 'OCCUPIED',
  DIRTY = 'DIRTY',
  OOO = 'OOO',
}

export enum RoomCategory {
  AC = 'AC',
  NON_AC = 'NON_AC',
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

  /** Null on rooms created before categories; set it with PATCH /rooms/:id. */
  @Prop({ type: String, enum: [...Object.values(RoomCategory), null], default: null })
  category: RoomCategory | null;

  /** Nightly rate for one guest. Null on older rooms, which use `rate`. */
  @Prop(money({ required: false, default: null }))
  singleRate: Types.Decimal128 | null;

  /** Nightly rate for two guests. Null on older rooms, which use `rate`. */
  @Prop(money({ required: false, default: null }))
  doubleRate: Types.Decimal128 | null;

  /** Legacy field, always equal to singleRate. Stays snapshot their own rate. */
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
RoomSchema.index({ category: 1 });
