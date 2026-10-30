import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { PaymentMode } from '../../common/enums';
import { businessDate, buildSchema, money, ref } from '../../database/build-schema';

@Schema({ collection: 'expenses', timestamps: true })
export class Expense {
  @Prop(businessDate())
  businessDate: string;

  @Prop({ required: true, trim: true })
  head: string;

  @Prop({ type: String, trim: true, default: '' })
  vendor: string;

  @Prop({ type: String, required: true, enum: Object.values(PaymentMode) })
  mode: PaymentMode;

  @Prop(money())
  amount: Types.Decimal128;

  @Prop({ type: String, default: '' })
  narration: string;

  /** The DEBIT CashTxn this expense posted. */
  @Prop(ref('CashTxn', { required: false }))
  txnId: Types.ObjectId | null;

  @Prop(ref('User'))
  createdByUserId: Types.ObjectId;
}

export type ExpenseDocument = HydratedDocument<Expense>;
export const ExpenseSchema = buildSchema(Expense);

ExpenseSchema.index({ businessDate: 1, head: 1 });
