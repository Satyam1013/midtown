import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, money, ref } from '../../database/build-schema';

export enum KotStatus {
  PLACED = 'PLACED',
  PREPARING = 'PREPARING',
  ON_THE_WAY = 'ON_THE_WAY',
  SERVED = 'SERVED',
}

export enum KotBillTo {
  ROOM = 'ROOM',
  PAY_NOW = 'PAY_NOW',
}

export enum KotSource {
  FRONT_DESK = 'FRONT_DESK',
  GUEST_APP = 'GUEST_APP',
}

// Snapshot of a menu line at order time; later menu price changes don't
// alter an existing KOT.
@Schema({ _id: false })
export class KotItem {
  @Prop(ref('MenuItem', { required: false }))
  menuItemId: Types.ObjectId | null;

  @Prop({ required: true })
  name: string;

  @Prop(money())
  price: Types.Decimal128;

  @Prop({ required: true, min: 1 })
  qty: number;

  @Prop({ type: String, default: '' })
  note: string;
}
export const KotItemSchema = SchemaFactory.createForClass(KotItem);

@Schema({ collection: 'kots', timestamps: true })
export class Kot {
  /** Running KOT number shown on the kitchen ticket. */
  @Prop({ required: true, min: 1 })
  number: number;

  @Prop(ref('Stay', { required: false }))
  stayId: Types.ObjectId | null;

  @Prop({ type: String, trim: true, default: null })
  tableLabel: string | null;

  @Prop({ type: [KotItemSchema], required: true })
  items: KotItem[];

  /** Sum of items before GST. */
  @Prop(money())
  taxable: Types.Decimal128;

  @Prop(money())
  cgst: Types.Decimal128;

  @Prop(money())
  sgst: Types.Decimal128;

  /** taxable + cgst + sgst, computed server-side. */
  @Prop(money())
  total: Types.Decimal128;

  @Prop(ref('Staff', { required: false }))
  waiterId: Types.ObjectId | null;

  @Prop({ type: String, enum: Object.values(KotStatus), default: KotStatus.PLACED })
  status: KotStatus;

  @Prop({ type: String, required: true, enum: Object.values(KotBillTo) })
  billTo: KotBillTo;

  @Prop({ type: String, required: true, enum: Object.values(KotSource) })
  source: KotSource;

  @Prop({ type: String, default: '' })
  note: string;

  /** PAY_NOW KOTs: set when settled through POST /bills/settle. */
  @Prop({ type: Date, default: null })
  settledAt: Date | null;
}

export type KotDocument = HydratedDocument<Kot>;
export const KotSchema = buildSchema(Kot);

KotSchema.index({ number: 1 }, { unique: true });
KotSchema.index({ status: 1, createdAt: 1 }); // kitchen queue
KotSchema.index({ stayId: 1, createdAt: -1 }); // guest order tracker
KotSchema.index({ createdAt: -1 });
