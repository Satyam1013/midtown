import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { businessDate, buildSchema, money, ref } from '../../database/build-schema';

export enum ShiftKind {
  UPGRADE = 'UPGRADE',
  DOWNGRADE = 'DOWNGRADE',
  SAME = 'SAME',
}

@Schema({ collection: 'room_shifts', timestamps: true })
export class RoomShift {
  @Prop(ref('Stay'))
  stayId: Types.ObjectId;

  /** The guest's ROOM_SHIFT request this shift answered; null for a shift the manager started. */
  @Prop(ref('ServiceRequest', { required: false }))
  requestId: Types.ObjectId | null;

  @Prop(ref('Room'))
  fromRoomId: Types.ObjectId;

  @Prop(ref('Room'))
  toRoomId: Types.ObjectId;

  @Prop(money())
  fromRate: Types.Decimal128;

  @Prop(money())
  toRate: Types.Decimal128;

  @Prop({ type: String, required: true, enum: Object.values(ShiftKind) })
  kind: ShiftKind;

  @Prop(businessDate())
  businessDate: string;

  @Prop({ required: true, match: /^\d{2}:\d{2}$/ })
  time: string;

  @Prop({ required: true, min: 0 })
  nightsBefore: number;

  @Prop({ required: true, min: 0 })
  nightsLeft: number;

  /** (toRate − fromRate) × nightsLeft, before GST. Negative for a downgrade. */
  @Prop(money())
  adjustment: Types.Decimal128;

  @Prop({ type: String, default: '' })
  reason: string;

  @Prop(ref('User'))
  createdByUserId: Types.ObjectId;
}

export type RoomShiftDocument = HydratedDocument<RoomShift>;
export const RoomShiftSchema = buildSchema(RoomShift);

RoomShiftSchema.index({ stayId: 1, createdAt: 1 });
// One shift per request. Partial, so any number of manager shifts (no request) can exist.
// Replaces the old full unique index `requestId_1`, dropped at startup by StaysModule.
RoomShiftSchema.index(
  { requestId: 1 },
  { unique: true, name: 'one_shift_per_request', partialFilterExpression: { requestId: { $type: 'objectId' } } },
);
