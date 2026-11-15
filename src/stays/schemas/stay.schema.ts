import { MAX_GUESTS } from '../../config/pricing';
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

  @Prop({ required: true, min: 1, max: MAX_GUESTS })
  guests: number;

  @Prop(money())
  rate: Types.Decimal128;

  @Prop({ required: true, min: 0 })
  nights: number;

  /** The TARIFF folio line billing this segment (rate × nights + GST). */
  @Prop(ref('FolioLine', { required: false }))
  folioLineId: Types.ObjectId | null;

  /** GST slab applied to this segment. */
  @Prop({ type: Number, default: null })
  gstPct: number | null;
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
  @Prop({ required: true, min: 1, max: MAX_GUESTS, default: 1 })
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

  /** GST mode fixed at check-in. Null on older stays, which keep 12% on top. */
  @Prop({ type: { inclusive: { type: Boolean, required: true } }, default: null, _id: false })
  gst: { inclusive: boolean } | null;

  /** Sequential bill number, e.g. MTH/2026-27/00123, given once at check-out. */
  @Prop({ type: String, default: null })
  billNo: string | null;

  @Prop({ type: String, default: null })
  billDate: string | null;

  /** The main guest. Null only on stays from before customers, until migrated. */
  @Prop(ref('Customer', { required: false }))
  customerId: Types.ObjectId | null;
}

export type StayDocument = HydratedDocument<Stay>;
export const StaySchema = buildSchema(Stay);
StaySchema.index({ customerId: 1, checkIn: -1 });
StaySchema.index({ billNo: 1 }, { unique: true, name: 'one_bill_number', partialFilterExpression: { billNo: { $type: 'string' } } });

// At most one live in-house stay per room.
StaySchema.index(
  { roomId: 1 },
  { unique: true, partialFilterExpression: { ...LIVE, status: StayStatus.IN_HOUSE }, name: 'one_in_house_stay_per_room' },
);
StaySchema.index({ roomId: 1, checkIn: -1 });
StaySchema.index({ status: 1, checkIn: -1 });
StaySchema.index({ phone: 1 });
