import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { buildSchema, ref } from '../../database/build-schema';

export enum AuditAction {
  ROOM_SHIFT = 'ROOM_SHIFT',
  GUEST_COUNT_CHANGE = 'GUEST_COUNT_CHANGE',
  DAY_START = 'DAY_START',
  DAY_CLOSE = 'DAY_CLOSE',
  DAY_REOPEN = 'DAY_REOPEN',
  OPENING_BALANCE_CHANGE = 'OPENING_BALANCE_CHANGE',
}

@Schema({ collection: 'audit_logs', timestamps: true })
export class AuditLog {
  @Prop({ type: String, required: true, enum: Object.values(AuditAction) })
  action: AuditAction;

  @Prop(ref('Stay', { required: false }))
  stayId: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  businessDate: string | null;

  @Prop(ref('User'))
  userId: Types.ObjectId;

  /** Before/after snapshot; free-form on purpose, since it differs by action. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  details: Record<string, unknown>;
}

export type AuditLogDocument = HydratedDocument<AuditLog>;
export const AuditLogSchema = buildSchema(AuditLog);

AuditLogSchema.index({ stayId: 1, createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ businessDate: 1, createdAt: -1 });
