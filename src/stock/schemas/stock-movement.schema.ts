import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, ref } from '../../database/build-schema';

@Schema({ collection: 'stock_movements', timestamps: true })
export class StockMovement {
  @Prop(ref('StockItem'))
  stockItemId: Types.ObjectId;

  /** Positive = received, negative = issued / wasted. */
  @Prop({ type: Types.Decimal128, required: true })
  delta: Types.Decimal128;

  @Prop({ required: true, trim: true })
  reason: string;

  @Prop(ref('User'))
  userId: Types.ObjectId;
}

export type StockMovementDocument = HydratedDocument<StockMovement>;
export const StockMovementSchema = buildSchema(StockMovement);

StockMovementSchema.index({ stockItemId: 1, createdAt: -1 });
StockMovementSchema.index({ createdAt: -1 });
