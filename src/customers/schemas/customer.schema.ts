import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, LIVE, money } from '../../database/build-schema';
import { DocumentType } from './customer-document.schema';

// A person who stays at the hotel, matched across visits by phone.
@Schema({ collection: 'customers', timestamps: true })
export class Customer {
  @Prop({ type: String, trim: true, default: '' })
  name: string;

  /** Last 10 digits, or null for a guest who gave no phone. Unique among live customers. */
  @Prop({ type: String, default: null })
  phone: string | null;

  @Prop({ type: String, trim: true, lowercase: true, default: null })
  email: string | null;

  @Prop({ type: Date, default: null })
  firstVisitAt: Date | null;

  @Prop({ type: Date, default: null })
  lastVisitAt: Date | null;

  /** Stays this customer was part of (main guest or added guest). */
  @Prop({ type: Number, default: 0, min: 0 })
  visits: number;

  /** Charges billed on their checked-out stays (room incl. GST, food, other). */
  @Prop(money({ required: false, default: () => Types.Decimal128.fromString('0') }))
  totalSpent: Types.Decimal128;

  @Prop({ type: String, default: '' })
  notes: string;

  /** What the customer owes the hotel (udhaar). Changed only with a credit entry, in the same transaction. */
  @Prop(money({ required: false, default: () => Types.Decimal128.fromString('0') }))
  creditBalance: Types.Decimal128;

  /** Kept in step with customer_documents, for list filters. */
  @Prop({ type: Number, default: 0, min: 0 })
  documentCount: number;

  @Prop({ type: String, default: null })
  documentType: DocumentType | null;
}

export type CustomerDocument_ = HydratedDocument<Customer>;
export const CustomerSchema = buildSchema(Customer);
CustomerSchema.index(
  { phone: 1 },
  { unique: true, name: 'one_customer_per_phone', partialFilterExpression: { ...LIVE, phone: { $type: 'string' } } },
);
CustomerSchema.index({ lastVisitAt: -1, _id: -1 });
CustomerSchema.index({ name: 1 });
CustomerSchema.index({ creditBalance: -1 });
