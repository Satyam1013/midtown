import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { PaymentMode } from '../../common/enums';
import { buildSchema, money, ref } from '../../database/build-schema';

export enum CreditKind {
  /** The customer now owes more. No money moves. */
  CHARGE = 'CHARGE',
  /** The customer paid some of it; a receipt goes into the day book. */
  PAYMENT = 'PAYMENT',
}

// The ledger behind Customer.creditBalance: balance = charges − payments.
@Schema({ collection: 'customer_credit_entries', timestamps: true })
export class CustomerCreditEntry {
  @Prop(ref('Customer'))
  customerId: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(CreditKind), required: true })
  kind: CreditKind;

  @Prop(money())
  amount: Types.Decimal128;

  @Prop({ type: String, enum: [...Object.values(PaymentMode), null], default: null })
  mode: PaymentMode | null;

  @Prop({ type: String, default: '' })
  narration: string;

  @Prop({ type: String, required: true })
  businessDate: string;

  @Prop({ type: String, default: null })
  time: string | null;

  @Prop(ref('User'))
  createdByUserId: Types.ObjectId;

  @Prop(ref('Stay', { required: false }))
  stayId: Types.ObjectId | null;

  @Prop(ref('Invoice', { required: false }))
  invoiceId: Types.ObjectId | null;

  /** PAYMENT only: its day-book receipt. */
  @Prop(ref('DayRegisterEntry', { required: false }))
  entryId: Types.ObjectId | null;
}

export type CustomerCreditEntryDocument = HydratedDocument<CustomerCreditEntry>;
export const CustomerCreditEntrySchema = buildSchema(CustomerCreditEntry);
CustomerCreditEntrySchema.index({ customerId: 1, createdAt: -1 });
CustomerCreditEntrySchema.index({ kind: 1, businessDate: 1 });
