import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { PaymentMode } from '../../common/enums';
import { businessDate, buildSchema, money, ref } from '../../database/build-schema';

@Schema({ collection: 'expenses', timestamps: true })
export class Expense {
  @Prop(businessDate())
  businessDate: string;

  /** Front-desk clock time, 'HH:mm'. */
  @Prop({ type: String, default: null, match: /^\d{2}:\d{2}$/ })
  time: string | null;

  @Prop({ required: true, trim: true })
  head: string;

  @Prop({ type: String, trim: true, default: '' })
  vendor: string;

  /** How it was paid. Null for an expense bought on credit, which is paid later. */
  @Prop({ type: String, enum: [...Object.values(PaymentMode), null], default: null })
  mode: PaymentMode | null;

  /** Bought on credit (udhari): booked as an expense now, cash moves only with each payment. */
  @Prop({ type: Boolean, default: false })
  onCredit: boolean;

  @Prop({ type: String, default: null })
  dueDate: string | null;

  /** Paid so far (credit expenses); equals amount for a cash expense. */
  @Prop(money({ required: false, default: null }))
  paidAmount: Types.Decimal128 | null;

  /** amount − paidAmount. */
  @Prop(money({ required: false, default: null }))
  dueAmount: Types.Decimal128 | null;

  @Prop({
    type: [
      {
        _id: false,
        entryId: { type: Types.ObjectId, ref: 'DayRegisterEntry' },
        amount: { type: Types.Decimal128 },
        mode: { type: String },
        businessDate: { type: String },
        time: { type: String },
        userId: { type: Types.ObjectId, ref: 'User' },
        paidAt: { type: Date },
      },
    ],
    default: [],
  })
  payments: { entryId: Types.ObjectId; amount: Types.Decimal128; mode: PaymentMode; businessDate: string; time: string; userId: Types.ObjectId; paidAt: Date }[];

  @Prop(money())
  amount: Types.Decimal128;

  @Prop({ type: String, default: '' })
  narration: string;

  /** The DEBIT CashTxn this expense posted. */
  @Prop(ref('CashTxn', { required: false }))
  txnId: Types.ObjectId | null;

  @Prop(ref('User'))
  createdByUserId: Types.ObjectId;

  /** Salary advances: the staff member paid, so payroll can deduct it. */
  @Prop(ref('Staff', { required: false }))
  staffId: Types.ObjectId | null;

  /** Deleted expenses only: who deleted it. */
  @Prop(ref('User', { required: false }))
  deletedByUserId: Types.ObjectId | null;
}

export type ExpenseDocument = HydratedDocument<Expense>;
export const ExpenseSchema = buildSchema(Expense);

ExpenseSchema.index({ businessDate: 1, head: 1 });
ExpenseSchema.index({ onCredit: 1, dueAmount: 1, dueDate: 1 });
ExpenseSchema.index({ vendor: 1, onCredit: 1 });
ExpenseSchema.index({ staffId: 1, businessDate: -1 }, { partialFilterExpression: { staffId: { $type: 'objectId' } } });
