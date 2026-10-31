import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, ref } from '../../database/build-schema';

@Schema({ collection: 'otp_challenges', timestamps: true })
export class OtpChallenge {
  @Prop(ref('Stay'))
  stayId: Types.ObjectId;

  /** HMAC of the code; the code itself is never stored. */
  @Prop({ required: true, select: false })
  codeHash: string;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ type: Date, default: null })
  consumedAt: Date | null;
}

export type OtpChallengeDocument = HydratedDocument<OtpChallenge>;
export const OtpChallengeSchema = buildSchema(OtpChallenge);

OtpChallengeSchema.index({ stayId: 1, createdAt: -1 });
OtpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
