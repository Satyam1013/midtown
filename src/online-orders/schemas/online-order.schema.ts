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

  @Prop(money())
  amount: Types.Decimal128;

  @Prop({ type: MongooseSchema.Types.Decimal128, required: true })
  commissionPct: Types.Decimal128;

  /** amount − commission, computed server-side. */
  @Prop(money())
  payout: Types.Decimal128;

  // The manager app sends no status on create and shows this title-cased.
  @Prop({ type: String, trim: true, default: 'PREPARING' })
  status: string;

  /** The register line posting the payout. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'DayRegisterEntry', default: null })
  entryId: Types.ObjectId | null;
}

export type OnlineOrderDocument = HydratedDocument<OnlineOrder>;
export const OnlineOrderSchema = buildSchema(OnlineOrder);

OnlineOrderSchema.index({ platform: 1, orderId: 1 }, { unique: true, partialFilterExpression: LIVE });
OnlineOrderSchema.index({ businessDate: 1, platform: 1 });
