import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types, Schema as MongooseSchema } from 'mongoose';
import { buildSchema, LIVE, money } from '../../database/build-schema';

@Schema({ collection: 'stock_items', timestamps: true })
export class StockItem {
  @Prop({ required: true, trim: true })
  item: string;

  @Prop({ required: true, trim: true })
  category: string;

  /** pcs / kg / L / bottle … */
  @Prop({ required: true, trim: true })
  unit: string;

  // Quantities are decimal (kg, litres) and must not drift, so they use
  // Decimal128 like money. Changed only through StockMovement.
  @Prop({ type: MongooseSchema.Types.Decimal128, required: true })
  qty: Types.Decimal128;

  @Prop({ type: MongooseSchema.Types.Decimal128, required: true })
  minQty: Types.Decimal128;

  /** Purchase rate per unit. */
  @Prop(money())
  rate: Types.Decimal128;
}

export type StockItemDocument = HydratedDocument<StockItem>;
export const StockItemSchema = buildSchema(StockItem);

StockItemSchema.index({ item: 1 }, { unique: true, partialFilterExpression: LIVE });
StockItemSchema.index({ category: 1, item: 1 });
