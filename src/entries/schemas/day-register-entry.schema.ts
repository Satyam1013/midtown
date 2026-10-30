import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { DebitCredit, PaymentMode } from '../../common/enums';
import { businessDate, buildSchema, LIVE, money, ref } from '../../database/build-schema';

@Schema({ collection: 'day_register_entries', timestamps: true })
export class DayRegisterEntry {
  @Prop(businessDate())
  businessDate: string;

  /** Wall-clock time of the entry, 'HH:mm', as shown in the register. */
  @Prop({ required: true, match: /^\d{2}:\d{2}$/ })
  time: string;

  @Prop(ref('Room', { required: false }))
  roomId: Types.ObjectId | null;

  /** Set when the entry was posted from a stay (advance / part payment / refund). */
  @Prop(ref('Stay', { required: false }))
  stayId: Types.ObjectId | null;

  @Prop({ type: String, trim: true, default: '' })
  guestName: string;

  @Prop({ type: String, trim: true, default: null })
  phone: string | null;

  @Prop({ type: String, trim: true, default: null })
  vehicle: string | null;

  /** Register column, e.g. Room Rent / Advance / Food / Refund. */
  @Prop({ required: true, trim: true })
  type: string;

  @Prop({ type: String, required: true, enum: Object.values(PaymentMode) })
  mode: PaymentMode;

  @Prop({ type: String, required: true, enum: Object.values(DebitCredit) })
  dc: DebitCredit;

  /** Zero is allowed (a register line with no money yet); never negative. */
  @Prop(money())
  amount: Types.Decimal128;

  @Prop({ type: String, default: '' })
  narration: string;

  /** The CashTxn this entry produced; null while amount is zero. */
  @Prop(ref('CashTxn', { required: false }))
  txnId: Types.ObjectId | null;

  @Prop(ref('User'))
  createdByUserId: Types.ObjectId;
}

export type DayRegisterEntryDocument = HydratedDocument<DayRegisterEntry>;
export const DayRegisterEntrySchema = buildSchema(DayRegisterEntry);

DayRegisterEntrySchema.index({ businessDate: 1, createdAt: 1 });
DayRegisterEntrySchema.index({ roomId: 1, businessDate: 1 });
DayRegisterEntrySchema.index({ stayId: 1 });
// Database backstop for the "no double entry" rule. The service checks
// first and answers 409 DUPLICATE_ENTRY; this index catches the race where
// two desks submit the same entry at the same moment. Guest name compares
// case-insensitively (collation strength 2).
DayRegisterEntrySchema.index(
  { businessDate: 1, roomId: 1, type: 1, amount: 1, guestName: 1 },
  {
    name: 'no_duplicate_entry',
    unique: true,
    collation: { locale: 'en', strength: 2 },
    partialFilterExpression: { ...LIVE, roomId: { $type: 'objectId' }, amount: { $gt: 0 } },
  },
);
