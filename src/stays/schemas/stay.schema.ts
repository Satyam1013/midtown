import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { businessDate, buildSchema, LIVE, money, ref } from '../../database/build-schema';

export enum StayStatus {
  IN_HOUSE = 'IN_HOUSE',
  CHECKED_OUT = 'CHECKED_OUT',
}

/**
 * One stretch of the stay in one room at one rate. A guest-count change or a
 * room shift closes the current segment and opens the next, so earlier
 * nights keep the price they were charged at.
 */
@Schema({ _id: true })
export class RoomCharge {
  @Prop({ required: true })
  label: string;

  @Prop(ref('Room'))
  roomId: Types.ObjectId;

  @Prop({ required: true })
  roomNumber: string;

  @Prop({ required: true, min: 1, max: 4 })
  guests: number;

  @Prop(money())
  rate: Types.Decimal128;

  @Prop({ required: true, min: 0 })
  nights: number;

  /** The TARIFF folio line billing this segment (rate × nights + GST). */
  @Prop(ref('FolioLine', { required: false }))
  folioLineId: Types.ObjectId | null;
}
export const RoomChargeSchema = SchemaFactory.createForClass(RoomCharge);

@Schema({ collection: 'stays', timestamps: true })
export class Stay {
  @Prop(ref('Room'))
  roomId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  guestName: string;

  /** Guest OTP login matches against this, so it is stored normalized (digits only). */
  @Prop({ type: String, trim: true, default: '' })
  phone: string;

  @Prop({ type: String, trim: true, default: null })
  vehicle: string | null;

  // 'YYYY-MM-DD'. The front-ends slice these to 10 characters; a UTC timestamp
  // would show the previous day for anything before 05:30 IST.
  @Prop(businessDate())
  checkIn: string;

  /** Planned end of stay, 'YYYY-MM-DD'. */
  @Prop(businessDate())
  checkOut: string;

  @Prop({ required: true, min: 1 })
  nights: number;

  /** Current nightly rate, before GST (the last segment's). */
  @Prop(money())
  rate: Types.Decimal128;

  /** Current number of guests, 1–4. */
  @Prop({ required: true, min: 1, max: 4, default: 1 })
  guests: number;

  /** In order; nights add up to `nights`. Empty on stays from before segments. */
  @Prop({ type: [RoomChargeSchema], default: [] })
  roomCharges: RoomCharge[];

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
