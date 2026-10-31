import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, Schema as MongooseSchema } from 'mongoose';
import { businessDate, buildSchema, money, ref } from '../../database/build-schema';

@Schema({ _id: false })
export class InvoiceLine {
  @Prop({ required: true })
  description: string;

  /** HSN/SAC code: 996311 rooms, 996331 restaurant. */
  @Prop({ type: String, default: null })
  sac: string | null;

  @Prop({ type: MongooseSchema.Types.Decimal128, required: true })
  qty: Types.Decimal128;

  @Prop(money())
  rate: Types.Decimal128;

  /** Total GST rate for the line (12 rooms, 5 food); split equally CGST/SGST. */
  @Prop({ type: MongooseSchema.Types.Decimal128, required: true })
  gstPct: Types.Decimal128;

  @Prop(money())
  taxable: Types.Decimal128;

  @Prop(money())
  cgst: Types.Decimal128;

  @Prop(money())
  sgst: Types.Decimal128;

  @Prop(money())
  total: Types.Decimal128;
}
export const InvoiceLineSchema = SchemaFactory.createForClass(InvoiceLine);

@Schema({ collection: 'invoices', timestamps: true })
export class Invoice {
  /** Sequential GST invoice number; never reused, even if voided. */
  @Prop({ required: true, trim: true })
  number: string;

  @Prop(businessDate())
  businessDate: string;

  @Prop({ required: true, trim: true })
  party: string;

  @Prop({ type: String, trim: true, uppercase: true, default: null })
  partyGstin: string | null;

  @Prop({ type: [InvoiceLineSchema], required: true })
  lines: InvoiceLine[];

  @Prop(money())
  taxable: Types.Decimal128;

  @Prop(money())
  cgst: Types.Decimal128;

  @Prop(money())
  sgst: Types.Decimal128;

  @Prop(money())
  total: Types.Decimal128;

  @Prop(ref('Stay', { required: false }))
  stayId: Types.ObjectId | null;
}

export type InvoiceDocument = HydratedDocument<Invoice>;
export const InvoiceSchema = buildSchema(Invoice);

// Unique across soft-deleted invoices: GST numbering must never repeat.
InvoiceSchema.index({ number: 1 }, { unique: true });
InvoiceSchema.index({ businessDate: 1 });
InvoiceSchema.index({ stayId: 1 });
