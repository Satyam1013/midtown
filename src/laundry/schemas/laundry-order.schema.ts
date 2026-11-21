import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { PaymentMode } from '../../common/enums';
import { buildSchema, money, ref } from '../../database/build-schema';

export enum LaundrySource {
  ROOM_REQUEST = 'ROOM_REQUEST',
  STAFF = 'STAFF',
  WALK_IN = 'WALK_IN',
}

export enum LaundryStatus {
  REQUESTED = 'REQUESTED',
  PICKED_UP = 'PICKED_UP',
  IN_PROCESS = 'IN_PROCESS',
  READY = 'READY',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

export enum LaundryServiceKind {
  WASH = 'WASH',
  IRON = 'IRON',
  WASH_IRON = 'WASH_IRON',
  DRY_CLEAN = 'DRY_CLEAN',
}

@Schema({ _id: true })
export class LaundryItem {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, required: true, enum: Object.values(LaundryServiceKind) })
  service: LaundryServiceKind;

  @Prop({ required: true, min: 1 })
  qty: number;

  /** Per piece, before GST. */
  @Prop(money())
  price: Types.Decimal128;
}
export const LaundryItemSchema = SchemaFactory.createForClass(LaundryItem);

@Schema({ collection: 'laundry_orders', timestamps: true })
export class LaundryOrder {
  /** Running number; shown as LND-0001. */
  @Prop({ required: true, min: 1 })
  seq: number;

  @Prop({ required: true })
  number: string;

  @Prop(ref('Stay', { required: false }))
  stayId: Types.ObjectId | null;

  @Prop(ref('Room', { required: false }))
  roomId: Types.ObjectId | null;

  @Prop({ type: String, trim: true, default: '' })
  guestName: string;

  @Prop({ type: String, trim: true, default: '' })
  phone: string;

  @Prop({ type: String, required: true, enum: Object.values(LaundrySource) })
  source: LaundrySource;

  /** The guest's laundry service request this order came from. */
  @Prop(ref('ServiceRequest', { required: false }))
  requestId: Types.ObjectId | null;

  /** requestId while the order is live (not cancelled): one live order per request, by unique index. */
  @Prop({ type: Types.ObjectId, default: null })
  liveRequestId: Types.ObjectId | null;

  @Prop({ type: String, enum: Object.values(LaundryStatus), default: LaundryStatus.REQUESTED })
  status: LaundryStatus;

  @Prop({ type: Boolean, default: false })
  express: boolean;

  @Prop({ type: String, default: null })
  expectedDate: string | null;

  @Prop({ type: String, required: true, enum: ['ROOM', 'PAY_NOW'] })
  billTo: 'ROOM' | 'PAY_NOW';

  /** PAY_NOW: how the guest pays; may also be given when it is delivered. */
  @Prop({ type: String, enum: [...Object.values(PaymentMode), null], default: null })
  mode: PaymentMode | null;

  @Prop({ type: [LaundryItemSchema], default: [] })
  items: LaundryItem[];

  /** Σ qty × price, before the express surcharge and GST. */
  @Prop(money())
  subtotal: Types.Decimal128;

  @Prop(money())
  expressCharge: Types.Decimal128;

  /** subtotal + expressCharge: the order value before GST, as the app shows it. */
  @Prop(money())
  amount: Types.Decimal128;

  @Prop({ type: Number, required: true })
  gstPct: number;

  @Prop(money())
  cgst: Types.Decimal128;

  @Prop(money())
  sgst: Types.Decimal128;

  /** What the guest pays: amount + GST. Posted to the folio or the day book on delivery. */
  @Prop(money())
  total: Types.Decimal128;

  @Prop({ type: String, default: '' })
  note: string;

  /** Business day it was taken. */
  @Prop({ type: String, required: true })
  businessDate: string;

  @Prop({ type: String, required: true })
  time: string;

  @Prop({ type: Date, default: null }) pickedUpAt: Date | null;
  @Prop({ type: Date, default: null }) readyAt: Date | null;
  @Prop({ type: Date, default: null }) deliveredAt: Date | null;
  @Prop({ type: Date, default: null }) cancelledAt: Date | null;

  /** Business day it was delivered (and its money posted). */
  @Prop({ type: String, default: null })
  deliveredDate: string | null;

  @Prop(ref('FolioLine', { required: false }))
  folioLineId: Types.ObjectId | null;

  @Prop(ref('DayRegisterEntry', { required: false }))
  entryId: Types.ObjectId | null;

  @Prop(ref('User'))
  createdByUserId: Types.ObjectId;
}

export type LaundryOrderDocument = HydratedDocument<LaundryOrder>;
export const LaundryOrderSchema = buildSchema(LaundryOrder);

LaundryOrderSchema.index({ seq: 1 }, { unique: true });
LaundryOrderSchema.index({ businessDate: 1, createdAt: -1 });
LaundryOrderSchema.index({ status: 1, createdAt: -1 });
LaundryOrderSchema.index({ stayId: 1, createdAt: -1 });
LaundryOrderSchema.index({ deliveredDate: 1 });
LaundryOrderSchema.index({ liveRequestId: 1 }, { unique: true, partialFilterExpression: { liveRequestId: { $type: 'objectId' } } });

/** The editable price list: one document. */
@Schema({ collection: 'laundry_prices', timestamps: true })
export class LaundryPriceList {
  @Prop({ type: Number, required: true, min: 0, max: 500 })
  expressPct: number;

  @Prop({
    type: [{ _id: false, name: { type: String, required: true }, service: { type: String, enum: Object.values(LaundryServiceKind), required: true }, price: { type: Types.Decimal128, required: true } }],
    default: [],
  })
  items: { name: string; service: LaundryServiceKind; price: Types.Decimal128 }[];
}
export const LaundryPriceListSchema = buildSchema(LaundryPriceList);
