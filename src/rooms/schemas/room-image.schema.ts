import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, ref } from '../../database/build-schema';

@Schema({ collection: 'room_images', timestamps: true })
export class RoomImage {
  @Prop(ref('Room'))
  roomId: Types.ObjectId;

  /** The photo in the public_images bucket. */
  @Prop({ type: Types.ObjectId, required: true })
  fileId: Types.ObjectId;

  @Prop({ required: true })
  url: string;

  @Prop({ required: true, default: 0 })
  sortOrder: number;
}

export type RoomImageDocument = HydratedDocument<RoomImage>;
export const RoomImageSchema = buildSchema(RoomImage);
RoomImageSchema.index({ roomId: 1, sortOrder: 1 });
