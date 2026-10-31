import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { businessDate, buildSchema, LIVE, money, ref } from '../../database/build-schema';

export enum BookingSource {
  MakeMyTrip = 'MakeMyTrip',
  BookingCom = 'Booking.com',
  Goibibo = 'Goibibo',
  Agoda = 'Agoda',
  Airbnb = 'Airbnb', // offered by the manager app's booking form
  WalkIn = 'Walk-in',
  Phone = 'Phone',
  GuestApp = 'GuestApp',
}

export enum BookingStatus {
  REQUESTED = 'REQUESTED',
  CONFIRMED = 'CONFIRMED',
  ARRIVING = 'ARRIVING',
  CHECKED_IN = 'CHECKED_IN',
  CANCELLED = 'CANCELLED',
}

@Schema({ collection: 'bookings', timestamps: true })
export class Booking {
  @Prop({ type: String, required: true, enum: Object.values(BookingSource) })
  source: BookingSource;

  /** OTA confirmation number; null for walk-in / phone / guest-app requests. */
  @Prop({ type: String, trim: true, default: null })
  ref: string | null;

  @Prop({ required: true, trim: true })
  guestName: string;

  @Prop({ type: String, trim: true, default: '' })
  phone: string;

  @Prop(ref('RoomType'))
  roomTypeId: Types.ObjectId;

  @Prop({ required: true, min: 1, default: 1 })
  rooms: number;

  @Prop({ required: true, min: 1, default: 1 })
  pax: number;

  @Prop(businessDate())
  arrivalDate: string;

  @Prop(businessDate())
  departureDate: string;

  @Prop(money({ default: () => Types.Decimal128.fromString('0.00') }))
  amount: Types.Decimal128;

  /** Payment arrangement as shown in the app, e.g. Prepaid / Pay at hotel. */
  @Prop({ type: String, trim: true, default: '' })
  payment: string;

  @Prop({ type: String, enum: Object.values(BookingStatus), default: BookingStatus.REQUESTED })
  status: BookingStatus;

  @Prop({ type: String, default: '' })
  note: string;
}

export type BookingDocument = HydratedDocument<Booking>;
export const BookingSchema = buildSchema(Booking);

BookingSchema.index({ arrivalDate: 1, status: 1 });
BookingSchema.index({ status: 1, createdAt: -1 });
BookingSchema.index({ phone: 1 });
// The same OTA booking can't be imported twice.
BookingSchema.index(
  { source: 1, ref: 1 },
  { unique: true, partialFilterExpression: { ...LIVE, ref: { $type: 'string' } } },
);
