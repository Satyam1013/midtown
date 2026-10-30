import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { buildSchema } from '../build-schema';

// Gap-free sequences (KOT numbers, GST invoice numbers). Incremented inside
// the caller's transaction, so an aborted transaction doesn't burn a number.
@Schema({ collection: 'counters', timestamps: true })
export class Counter {
  @Prop({ required: true })
  key: string;

  @Prop({ required: true, default: 0 })
  seq: number;
}

export type CounterDocument = HydratedDocument<Counter>;
export const CounterSchema = buildSchema(Counter);

CounterSchema.index({ key: 1 }, { unique: true });
