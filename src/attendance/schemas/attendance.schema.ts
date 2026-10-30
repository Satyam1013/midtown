import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { businessDate, buildSchema, LIVE, ref } from '../../database/build-schema';

export enum AttendanceMark {
  P = 'P',
  A = 'A',
  L = 'L',
}

@Schema({ collection: 'attendance', timestamps: true })
export class Attendance {
  @Prop(ref('Staff'))
  staffId: Types.ObjectId;

  @Prop(businessDate())
  businessDate: string;

  @Prop({ type: String, required: true, enum: Object.values(AttendanceMark) })
  mark: AttendanceMark;

  @Prop(ref('User', { required: false }))
  markedByUserId: Types.ObjectId | null;
}

export type AttendanceDocument = HydratedDocument<Attendance>;
export const AttendanceSchema = buildSchema(Attendance);

AttendanceSchema.index({ staffId: 1, businessDate: 1 }, { unique: true, partialFilterExpression: LIVE });
AttendanceSchema.index({ businessDate: 1 });
