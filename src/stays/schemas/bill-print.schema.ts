import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, ref } from '../../database/build-schema';

export type BillSectionAmounts = { stay: string | null; food: string | null; other: string | null; total: string };

// A record that a bill was printed. Audit only: it never touches the
// register, folio, payments, day book or report figures.
@Schema({ collection: 'bill_prints', timestamps: true })
export class BillPrint {
  @Prop(ref('Stay'))
  stayId: Types.ObjectId;

  @Prop(ref('User'))
  userId: Types.ObjectId;

  /** The business day it was printed on (the open day, else today). */
  @Prop({ type: String, required: true })
  businessDate: string;

  @Prop({ type: String, enum: ['MANUAL', 'GENERATED'], required: true })
  type: 'MANUAL' | 'GENERATED';

  @Prop({ type: String, enum: ['combined', 'stay', 'food', 'other', 'separate'], required: true })
  which: string;

  @Prop({ type: String, default: null })
  billNo: string | null;

  /** Amounts printed on the bill. */
  @Prop({ type: Object, required: true })
  amounts: BillSectionAmounts;

  /** Amounts the app said were the actual ones. */
  @Prop({ type: Object, required: true })
  actualAmounts: BillSectionAmounts;

  /** Actual amounts per the server's bill when printed. */
  @Prop({ type: Object, required: true })
  serverAmounts: BillSectionAmounts;

  /** printed − actual (app's figures), per section. */
  @Prop({ type: Object, required: true })
  difference: BillSectionAmounts;
}

export type BillPrintDocument = HydratedDocument<BillPrint>;
export const BillPrintSchema = buildSchema(BillPrint);
BillPrintSchema.index({ stayId: 1, createdAt: -1 });
BillPrintSchema.index({ businessDate: 1, type: 1 });
