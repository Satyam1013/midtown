import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { businessDate, buildSchema, LIVE, money, ref } from '../../database/build-schema';

export enum BusinessDayStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

// One document per business day (a shift). `businessDate` is chosen when the
// day is started, not taken from the clock, and a day can stay open past
// midnight. Days from before shifts have no status; a closedAt means CLOSED.
@Schema({ collection: 'day_books', timestamps: true })
export class DayBook {
  @Prop(businessDate())
  businessDate: string;

  @Prop(money({ default: () => Types.Decimal128.fromString('0.00') }))
  openingBalance: Types.Decimal128;

  /** Set only when the day is closed: opening + credits − debits from CashTxn. */
  @Prop(money({ required: false, default: null }))
  closingBalance: Types.Decimal128 | null;

  @Prop({ type: String, enum: [...Object.values(BusinessDayStatus), null], default: null })
  status: BusinessDayStatus | null;

  @Prop({ type: Date, default: null })
  openedAt: Date | null;

  @Prop(ref('User', { required: false }))
  openedByUserId: Types.ObjectId | null;

  /** Front-desk clock time at start / close, 'HH:mm'. */
  @Prop({ type: String, default: null })
  openedTime: string | null;

  @Prop({ type: String, default: null })
  closedTime: string | null;

  /** Why the opening balance differs from the last closing balance. */
  @Prop({ type: String, default: '' })
  startNote: string;

  /** Opening + net CASH-mode movements of the day. */
  @Prop(money({ required: false, default: null }))
  expectedCash: Types.Decimal128 | null;

  @Prop(money({ required: false, default: null }))
  countedCash: Types.Decimal128 | null;

  /** expected − counted. Negative means excess cash. */
  @Prop(money({ required: false, default: null }))
  shortage: Types.Decimal128 | null;

  @Prop({ type: String, default: '' })
  closeNote: string;

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
// Only one business day may be open at a time.
DayBookSchema.index(
  { status: 1 },
  { unique: true, name: 'one_open_day', partialFilterExpression: { ...LIVE, status: BusinessDayStatus.OPEN } },
);
DayBookSchema.index({ status: 1, closedAt: -1 });
