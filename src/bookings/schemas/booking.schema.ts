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
  /** Every room of the booking has checked out. */
  CHECKED_OUT = 'CHECKED_OUT',
  CANCELLED = 'CANCELLED',
  /** Didn't arrive by the end of the arrival day; set when that business day closes. */
  NO_SHOW = 'NO_SHOW',
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

  /** The room this booking holds for [arrivalDate, departureDate). Desk bookings always have one. */
  @Prop(ref('Room', { required: false }))
  roomId: Types.ObjectId | null;

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

  /** The customer who sees this booking in the guest app: the logged-in booker, else the one with this phone. */
  @Prop(ref('Customer', { required: false }))
  customerId: Types.ObjectId | null;

  /** Guests and nightly rate of each room, worked out when booked. Check-in charges these, whatever the tariff is later. */
  @Prop({
    type: [
      {
        roomTypeId: { type: Types.ObjectId, ref: 'RoomType' },
        guests: { type: Number, required: true },
        rate: { type: Types.Decimal128, required: true },
        rateCard: { type: { _id: false, singleRate: Types.Decimal128, doubleRate: Types.Decimal128, additionalGuestRate: Types.Decimal128 }, default: null },
        /** The stay that took this line at check-in; null until a room is assigned. */
        stayId: { type: Types.ObjectId, ref: 'Stay', default: null },
      },
    ],
    default: [],
  })
  roomLines: {
    _id: Types.ObjectId;
    roomTypeId: Types.ObjectId;
    guests: number;
    rate: Types.Decimal128;
    rateCard: { singleRate: Types.Decimal128; doubleRate: Types.Decimal128; additionalGuestRate: Types.Decimal128 } | null;
    stayId: Types.ObjectId | null;
  }[];

  /** The room type's prices when booked, for a room checked in with a different guest count. */
  @Prop({
    type: { _id: false, singleRate: Types.Decimal128, doubleRate: Types.Decimal128, additionalGuestRate: Types.Decimal128 },
    default: null,
  })
  rateCard: { singleRate: Types.Decimal128; doubleRate: Types.Decimal128; additionalGuestRate: Types.Decimal128 } | null;

  @Prop({ type: String, default: '' })
  note: string;
}

export type BookingDocument = HydratedDocument<Booking>;
export const BookingSchema = buildSchema(Booking);

BookingSchema.index({ arrivalDate: 1, status: 1 });
BookingSchema.index({ status: 1, createdAt: -1 });
BookingSchema.index({ phone: 1 });
BookingSchema.index({ roomId: 1, status: 1, arrivalDate: 1 }, { partialFilterExpression: { roomId: { $type: 'objectId' } } });
BookingSchema.index({ customerId: 1, createdAt: -1 });
// The same OTA booking can't be imported twice.
BookingSchema.index(
  { source: 1, ref: 1 },
  { unique: true, partialFilterExpression: { ...LIVE, ref: { $type: 'string' } } },
);
