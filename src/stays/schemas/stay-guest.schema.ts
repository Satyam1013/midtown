import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, money, ref } from '../../database/build-schema';

// A guest added to a stay after check-in.
@Schema({ collection: 'stay_guests', timestamps: true })
export class StayGuest {
  @Prop(ref('Stay'))
  stayId: Types.ObjectId;

  @Prop({ type: String, trim: true, default: '' })
  name: string;

  @Prop({ type: String, default: '' })
  phone: string;

  @Prop(ref('Customer', { required: false }))
  customerId: Types.ObjectId | null;

  @Prop({ type: Date, required: true })
  addedAt: Date;

  /** The date the guest joined; nights from it on are repriced. */
  @Prop({ type: String, required: true })
  businessDate: string;

  @Prop({ required: true, min: 2, max: 4 })
  guestsAfter: number;

  @Prop(money())
  fromRate: Types.Decimal128;

  @Prop(money())
  toRate: Types.Decimal128;

  @Prop({ required: true, min: 0 })
  nightsLeft: number;

  /** (toRate − fromRate) × nightsLeft, before GST. */
  @Prop(money())
  adjustment: Types.Decimal128;

  @Prop(ref('User'))
  addedByUserId: Types.ObjectId;
}

export type StayGuestDocument = HydratedDocument<StayGuest>;
export const StayGuestSchema = buildSchema(StayGuest);
StayGuestSchema.index({ stayId: 1, addedAt: 1 });
StayGuestSchema.index({ customerId: 1 });
