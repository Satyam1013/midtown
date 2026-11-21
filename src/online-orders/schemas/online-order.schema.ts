import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, Schema as MongooseSchema } from 'mongoose';
import { businessDate, buildSchema, LIVE, money } from '../../database/build-schema';

@Schema({ _id: false })
export class OnlineOrderItem {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, min: 1 })
  qty: number;

  @Prop(money())
  price: Types.Decimal128;
}
export const OnlineOrderItemSchema = SchemaFactory.createForClass(OnlineOrderItem);

export enum OnlineOrderStatus {
  PREPARING = 'PREPARING',
  PICKED_UP = 'PICKED_UP',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

@Schema({ collection: 'online_orders', timestamps: true })
export class OnlineOrder {
  @Prop(businessDate())
  businessDate: string;

  /** Zomato / Swiggy / Magicpin / Direct call */
  @Prop({ required: true, trim: true })
  platform: string;

  /** The platform's own order id. */
  @Prop({ required: true, trim: true })
  orderId: string;

  @Prop({ type: [OnlineOrderItemSchema], default: [] })
  items: OnlineOrderItem[];

  /** The order value: the only money field, posted to the day book as a BANK receipt. */
  @Prop(money())
  amount: Types.Decimal128;

  /** Orders from before commission was dropped; null on new ones. */
  @Prop({ type: MongooseSchema.Types.Decimal128, default: null })
  commissionPct: Types.Decimal128 | null;

  @Prop(money({ required: false, default: null }))
  payout: Types.Decimal128 | null;

  // Older orders may hold other strings; new ones and every change use OnlineOrderStatus.
  @Prop({ type: String, trim: true, default: OnlineOrderStatus.PREPARING })
  status: string;

  /** Front-desk clock time the order was added, 'HH:mm'. */
  @Prop({ type: String, default: null })
  time: string | null;

  /** The register line posting the payout. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'DayRegisterEntry', default: null })
  entryId: Types.ObjectId | null;
}

export type OnlineOrderDocument = HydratedDocument<OnlineOrder>;
export const OnlineOrderSchema = buildSchema(OnlineOrder);

OnlineOrderSchema.index({ platform: 1, orderId: 1 }, { unique: true, partialFilterExpression: LIVE });
OnlineOrderSchema.index({ businessDate: 1, platform: 1 });
