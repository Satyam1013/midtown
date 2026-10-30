import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, LIVE, money } from '../../database/build-schema';

@Schema({ collection: 'room_types', timestamps: true })
export class RoomType {
  /** Standard / Deluxe / Executive / Suite */
  @Prop({ required: true, trim: true })
  name: string;

  /** Rack rate per night, before GST. */
  @Prop(money())
  tariff: Types.Decimal128;

  @Prop({ required: true })
  beds: string;

  @Prop({ required: true })
  size: string;

  @Prop({ required: true, min: 1 })
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
