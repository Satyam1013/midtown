import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { RoomCategory } from '../../rooms/schemas/room.schema';
import { buildSchema, LIVE, money } from '../../database/build-schema';

@Schema({ collection: 'room_types', timestamps: true })
export class RoomType {
  /** Standard / Deluxe / Executive / Suite */
  @Prop({ required: true, trim: true })
  name: string;

  /** AC / NON_AC for the fixed types; null for the original four. */
  @Prop({ type: String, enum: [...Object.values(RoomCategory), null], default: null })
  category: RoomCategory | null;

  /**
   * Rack rate per night, before GST. Null for the category types, whose
   * rooms are priced one by one; lists then show the lowest room's rate.
   */
  @Prop(money({ required: false, default: null }))
  tariff: Types.Decimal128 | null;

  @Prop({ type: String, default: '' })
  beds: string;

  @Prop({ type: String, default: '' })
  size: string;

  @Prop({ required: true, min: 1, default: 2 })
  sleeps: number;

  @Prop({ default: '' })
  blurb: string;

  @Prop({ type: [String], default: [] })
  perks: string[];

  @Prop({ type: String, default: null })
  photoUrl: string | null;

  @Prop({ default: 0 })
  sortOrder: number;
}

export type RoomTypeDocument = HydratedDocument<RoomType>;
export const RoomTypeSchema = buildSchema(RoomType);

RoomTypeSchema.index({ name: 1 }, { unique: true, partialFilterExpression: LIVE });
RoomTypeSchema.index({ sortOrder: 1 });
