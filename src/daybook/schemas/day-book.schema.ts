import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { businessDate, buildSchema, money, ref } from '../../database/build-schema';

@Schema({ collection: 'day_books', timestamps: true })
export class DayBook {
  @Prop(businessDate())
  businessDate: string;

  @Prop(money({ default: () => Types.Decimal128.fromString('0.00') }))
  openingBalance: Types.Decimal128;

  /** Set only when the day is closed: opening + credits − debits from CashTxn. */
  @Prop(money({ required: false, default: null }))
  closingBalance: Types.Decimal128 | null;

  /**
   * Bumped by every transaction that posts to this date and by closing it,
   * so a post and a close running together conflict instead of interleaving.
   */
  @Prop({ default: 0 })
  rev: number;

  @Prop({ type: Date, default: null })
  closedAt: Date | null;

  @Prop(ref('User', { required: false }))
  closedByUserId: Types.ObjectId | null;
}

export type DayBookDocument = HydratedDocument<DayBook>;
export const DayBookSchema = buildSchema(DayBook);

DayBookSchema.index({ businessDate: 1 }, { unique: true });
