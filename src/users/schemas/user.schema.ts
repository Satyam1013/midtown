import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Role } from '../../common/enums';
import { buildSchema, LIVE } from '../../database/build-schema';

export const STAFF_ROLES = [Role.OWNER, Role.MANAGER, Role.STAFF, Role.KITCHEN] as const;

@Schema({ collection: 'users', timestamps: true })
export class User {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, trim: true })
  phone: string;

  @Prop({ type: String, trim: true, lowercase: true, default: null })
  email: string | null;

  @Prop({ required: true, select: false })
  passwordHash: string;

  // GUEST is never a stored user; guests authenticate per stay via OTP.
  @Prop({ type: String, required: true, enum: STAFF_ROLES })
  role: Role;

  @Prop({ default: true })
  active: boolean;

  /** Bumped to revoke every outstanding refresh token for this user. */
  @Prop({ default: 0, select: false })
  tokenVersion: number;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = buildSchema(User);

UserSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: LIVE });
UserSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { ...LIVE, email: { $type: 'string' } } },
);
