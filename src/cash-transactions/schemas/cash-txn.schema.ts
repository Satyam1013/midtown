import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { DebitCredit, PaymentMode } from '../../common/enums';
import { businessDate, buildSchema, LIVE, money, ref } from '../../database/build-schema';

// The cash book. Day-book balances are always computed from these
// documents, never from a stored running total.
@Schema({ collection: 'cash_txns', timestamps: true })
export class CashTxn {
  @Prop(businessDate())
  businessDate: string;

  @Prop({ required: true, trim: true })
  head: string;

  @Prop({ type: String, required: true, enum: Object.values(PaymentMode) })
  mode: PaymentMode;

  @Prop({ type: String, required: true, enum: Object.values(DebitCredit) })
  dc: DebitCredit;

  /** Always positive; direction is carried by dc. */
  @Prop(money())
  amount: Types.Decimal128;

  @Prop({ type: String, default: '' })
  narration: string;

  @Prop(ref('DayRegisterEntry', { required: false }))
  entryId: Types.ObjectId | null;

  @Prop(ref('Expense', { required: false }))
  expenseId: Types.ObjectId | null;
}

export type CashTxnDocument = HydratedDocument<CashTxn>;
export const CashTxnSchema = buildSchema(CashTxn);

CashTxnSchema.index({ businessDate: 1, dc: 1, mode: 1 });
// Never two live cash lines for the same entry or expense.
CashTxnSchema.index(
  { entryId: 1 },
  { unique: true, partialFilterExpression: { ...LIVE, entryId: { $type: 'objectId' } } },
);
CashTxnSchema.index(
  { expenseId: 1 },
  { unique: true, partialFilterExpression: { ...LIVE, expenseId: { $type: 'objectId' } } },
);
