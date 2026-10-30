import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, LIVE, money, ref } from '../../database/build-schema';

export enum FolioSource {
  TARIFF = 'TARIFF',
  FOOD = 'FOOD',
  PAYMENT = 'PAYMENT',
  REFUND = 'REFUND',
  OTHER = 'OTHER',
}

@Schema({ collection: 'folio_lines', timestamps: true })
export class FolioLine {
  @Prop(ref('Stay'))
  stayId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  head: string;

  /** Positive = charge to the guest; negative = payment received. */
  @Prop(money())
  amount: Types.Decimal128;

  @Prop({ type: String, required: true, enum: Object.values(FolioSource) })
  source: FolioSource;

  /** Day-register entry that recorded the money movement (payments / refunds). */
  @Prop(ref('DayRegisterEntry', { required: false }))
  entryId: Types.ObjectId | null;

  /** KOT billed to the room (FOOD lines). */
  @Prop(ref('Kot', { required: false }))
  kotId: Types.ObjectId | null;
}

export type FolioLineDocument = HydratedDocument<FolioLine>;
export const FolioLineSchema = buildSchema(FolioLine);

FolioLineSchema.index({ stayId: 1, createdAt: 1 });
// One folio line per entry and per KOT: retries can't double-post.
FolioLineSchema.index(
  { entryId: 1 },
  { unique: true, partialFilterExpression: { ...LIVE, entryId: { $type: 'objectId' } } },
);
FolioLineSchema.index(
  { kotId: 1 },
  { unique: true, partialFilterExpression: { ...LIVE, kotId: { $type: 'objectId' } } },
);
