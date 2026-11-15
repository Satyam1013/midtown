import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, money, ref } from '../../database/build-schema';

export enum RoomStatus {
  VACANT = 'VACANT',
  OCCUPIED = 'OCCUPIED',
  DIRTY = 'DIRTY',
  OOO = 'OOO',
  /** Under repair: not sold, checked into, shifted to or booked. Set by a manager. */
  MAINTENANCE = 'MAINTENANCE',
}

/** The fixed list of features a room can have. */
export const ROOM_FEATURES = [
  'AC',
  'TV',
  'Hot water / geyser',
  'Wi-Fi',
  'Attached bathroom',
  'Balcony',
  'Double bed',
  'Twin beds',
  'Extra bed available',
  'Fridge',
  'Sofa / seating',
  'Work desk',
  'Power backup',
  'Window view',
] as const;
export type RoomFeature = (typeof ROOM_FEATURES)[number];

/** Statuses in which a room can still be sold (DIRTY is cleaned before arrival). */
export const SELLABLE_STATUSES = ['VACANT', 'DIRTY', 'OCCUPIED'];

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

  @Prop({ type: [String], enum: ROOM_FEATURES, default: [] })
  features: RoomFeature[];

  @Prop({ type: String, trim: true, default: '' })
  description: string;

  /** Guest-facing details. Empty / null when not set. */
  @Prop({ type: String, trim: true, default: '' })
  beds: string;

  @Prop({ type: String, trim: true, default: '' })
  blurb: string;

  @Prop({ type: String, trim: true, default: '' })
  size: string;

  @Prop({ type: Number, default: null, min: 0 })
  sizeSqft: number | null;

  /** Most guests the room takes; null keeps the old limit of 4. */
  @Prop({ type: Number, default: null, min: 1, max: 10 })
  sleeps: number | null;

  /** Per extra guest (beyond 2) per night; null uses the hotel default of ₹300, 0 makes extras free. */
  @Prop(money({ required: false, default: null }))
  additionalGuestPrice: Types.Decimal128 | null;

  /** Set while status is MAINTENANCE, cleared on any other status. */
  @Prop({ type: String, default: null })
  maintenanceReason: string | null;

  /** Expected back date, 'YYYY-MM-DD'. */
  @Prop({ type: String, default: null })
  maintenanceUntil: string | null;

  @Prop({ type: Date, default: null })
  maintenanceSince: Date | null;

  @Prop(ref('User', { required: false }))
  maintenanceByUserId: Types.ObjectId | null;
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
