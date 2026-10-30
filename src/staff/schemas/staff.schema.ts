import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, money } from '../../database/build-schema';

// Payroll / attendance roster. Separate from User: most staff never log in.
@Schema({ collection: 'staff', timestamps: true })
export class Staff {
  @Prop({ required: true, trim: true })
  name: string;

  /** Job title as shown in the app (Manager, Chef, Waiter …), not an auth role. */
  @Prop({ required: true, trim: true })
  role: string;

  @Prop({ required: true, trim: true })
  shift: string;

  /** Monthly salary. */
  @Prop(money())
  salary: Types.Decimal128;
}

export type StaffDocument = HydratedDocument<Staff>;
export const StaffSchema = buildSchema(Staff);

StaffSchema.index({ name: 1 });
