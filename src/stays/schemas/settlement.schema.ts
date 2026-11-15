import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { PaymentMode } from '../../common/enums';
import { buildSchema, money, ref } from '../../database/build-schema';

// One check-out of one room. It owns the per-mode ledger rows taken at
// check-out (they stay in the ledger for cash and mode totals) and is what
// the register, entries list, customer history and day-book export show:
// one row per check-out.
@Schema({ collection: 'settlements', timestamps: true })
export class Settlement {
  @Prop(ref('Stay'))
  stayId: Types.ObjectId;

  @Prop(ref('Room'))
  roomId: Types.ObjectId;

  @Prop(ref('Customer', { required: false }))
  customerId: Types.ObjectId | null;

  @Prop({ type: String, required: true })
  businessDate: string;

  @Prop({ type: String, required: true })
  time: string;

  @Prop({ type: String, default: '' })
  guestName: string;

  @Prop({ type: String, default: '' })
  phone: string;

  @Prop({ type: String, default: null })
  vehicle: string | null;

  /** What the user typed; never a system-made sentence. */
  @Prop({ type: String, default: '' })
  narration: string;

  /** Folio charges at check-out, after adjustments. */
  @Prop(money())
  billTotal: Types.Decimal128;

  /** Collected at check-out (sum of `payments`). */
  @Prop(money())
  amount: Types.Decimal128;

  @Prop({
    type: [{ _id: false, entryId: { type: Types.ObjectId, ref: 'DayRegisterEntry' }, mode: { type: String }, amount: { type: Types.Decimal128 } }],
    default: [],
  })
  payments: { entryId: Types.ObjectId; mode: PaymentMode; amount: Types.Decimal128 }[];

  /** Moved to the customer's credit (udhaar). */
  @Prop(money({ required: false, default: null }))
  creditAmount: Types.Decimal128 | null;

  /** Unpaid balance left at check-out; null when fully settled. */
  @Prop(money({ required: false, default: null }))
  shortfall: Types.Decimal128 | null;

  @Prop({ type: String, default: null })
  idempotencyKey: string | null;

  @Prop(ref('User'))
  createdByUserId: Types.ObjectId;

  /** Built by the migration from rows posted before settlements existed. */
  @Prop({ type: Boolean, default: false })
  migrated: boolean;
}

export type SettlementDocument = HydratedDocument<Settlement>;
export const SettlementSchema = buildSchema(Settlement);
SettlementSchema.index({ businessDate: 1, time: 1 });
SettlementSchema.index({ stayId: 1 }, { unique: true, name: 'one_settlement_per_stay', partialFilterExpression: { deletedAt: { $type: 'null' } } });
SettlementSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
SettlementSchema.index({ customerId: 1, businessDate: -1 });
SettlementSchema.index({ shortfall: 1, businessDate: 1 });
