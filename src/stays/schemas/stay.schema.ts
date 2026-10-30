import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, LIVE, money, ref } from '../../database/build-schema';

export enum StayStatus {
  IN_HOUSE = 'IN_HOUSE',
  CHECKED_OUT = 'CHECKED_OUT',
}

@Schema({ collection: 'stays', timestamps: true })
export class Stay {
  @Prop(ref('Room'))
  roomId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  guestName: string;

  /** Guest OTP login matches against this, so it is stored normalized (digits only). */
  @Prop({ required: true, trim: true })
  phone: string;

  @Prop({ type: String, trim: true, default: null })
  vehicle: string | null;

  @Prop({ type: Date, required: true })
  checkIn: Date;

  /** Planned end of stay. */
  @Prop({ type: Date, required: true })
  checkOut: Date;

  @Prop({ required: true, min: 1 })
  nights: number;

  /** Nightly rate agreed for this stay, before GST. */
  @Prop(money())
  rate: Types.Decimal128;

  @Prop({ type: String, enum: Object.values(StayStatus), default: StayStatus.IN_HOUSE })
  status: StayStatus;

  /** Actual check-out time. Guest tokens for this stay are dead once set. */
  @Prop({ type: Date, default: null })
  checkedOutAt: Date | null;

  @Prop(ref('Booking', { required: false }))
  bookingId: Types.ObjectId | null;
}

export type StayDocument = HydratedDocument<Stay>;
export const StaySchema = buildSchema(Stay);

// At most one live in-house stay per room.
StaySchema.index(
  { roomId: 1 },
  { unique: true, partialFilterExpression: { ...LIVE, status: StayStatus.IN_HOUSE }, name: 'one_in_house_stay_per_room' },
);
StaySchema.index({ roomId: 1, checkIn: -1 });
StaySchema.index({ status: 1, checkIn: -1 });
StaySchema.index({ phone: 1 });
