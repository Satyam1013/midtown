import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, ref } from '../../database/build-schema';

@Schema({ collection: 'feedback', timestamps: true })
export class Feedback {
  @Prop(ref('Stay'))
  stayId: Types.ObjectId;

  @Prop({ required: true, min: 1, max: 5, validate: Number.isInteger })
  rating: number;

  @Prop({ type: String, trim: true, default: '' })
  text: string;
}

export type FeedbackDocument = HydratedDocument<Feedback>;
export const FeedbackSchema = buildSchema(Feedback);

FeedbackSchema.index({ stayId: 1, createdAt: -1 });
FeedbackSchema.index({ createdAt: -1 });
