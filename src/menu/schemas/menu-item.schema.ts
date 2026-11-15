import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, LIVE, money } from '../../database/build-schema';

@Schema({ collection: 'menu_items', timestamps: true })
export class MenuItem {
  @Prop({ required: true, trim: true })
  name: string;

  /** Price before GST. KOT totals are always recomputed from this. */
  @Prop(money())
  price: Types.Decimal128;

  @Prop({ required: true, trim: true })
  category: string;

  @Prop({ required: true })
  isVeg: boolean;

  @Prop({ type: String, default: '' })
  description: string;

  @Prop({ type: String, default: null })
  photoUrl: string | null;

  @Prop({ default: true })
  available: boolean;
}

export type MenuItemDocument = HydratedDocument<MenuItem>;
export const MenuItemSchema = buildSchema(MenuItem);

// One name per category, ignoring case. Replaces the old menu-wide `name_1`,
// which MenuModule drops at startup.
MenuItemSchema.index(
  { category: 1, name: 1 },
  { unique: true, name: 'menu_name_per_category', collation: { locale: 'en', strength: 2 }, partialFilterExpression: LIVE },
);
