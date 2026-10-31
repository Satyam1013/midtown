import { SchemaFactory } from '@nestjs/mongoose';
import { Schema } from 'mongoose';
import { baseSchemaPlugin } from './plugins/base-schema.plugin';

/** SchemaFactory.createForClass + the plugins every collection must have. */
export function buildSchema<T>(cls: new (...args: any[]) => T): Schema<T> {
  const schema = SchemaFactory.createForClass(cls) as unknown as Schema<T>;
  schema.plugin(baseSchemaPlugin);
  return schema;
}

// Note: schema types must be Schema.Types.*. The bson classes under `Types`
// silently produce Mixed paths, with no casting or validation.

/** @Prop options for a required money field. */
export const money = (opts: { required?: boolean; default?: unknown } = {}) => ({
  type: Schema.Types.Decimal128,
  required: opts.required ?? true,
  ...(opts.default !== undefined ? { default: opts.default } : {}),
});

/** @Prop options for an ObjectId reference. */
export const ref = (model: string, opts: { required?: boolean } = {}) => ({
  type: Schema.Types.ObjectId,
  ref: model,
  required: opts.required ?? true,
  ...(opts.required === false ? { default: null } : {}),
});

/** Business dates are stored as 'YYYY-MM-DD' in the hotel timezone. */
export const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const businessDate = (opts: { required?: boolean } = {}) => ({
  type: String,
  required: opts.required ?? true,
  match: BUSINESS_DATE,
});

/** Partial filter for unique indexes that should ignore soft-deleted docs. */
export const LIVE = { deletedAt: { $type: 'null' } } as const;
