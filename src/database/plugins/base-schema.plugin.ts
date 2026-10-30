import { Schema, Types } from 'mongoose';

// Applied to every schema via buildSchema(). Gives each collection:
//  - deletedAt (soft delete marker, null while live)
//  - default exclusion of soft-deleted docs from queries and aggregations
//  - a JSON shape for the front-ends: `id` string instead of `_id`,
//    ObjectId refs as strings, Decimal128 as numbers, no __v / deletedAt.
//
// Excluding deleted docs here is a convenience; services still scope their
// own queries explicitly and must not rely on this for authorization.

/** Query option: `Model.find(filter).setOptions({ withDeleted: true })`. */
export const WITH_DELETED = 'withDeleted';

const QUERY_HOOKS = [
  'countDocuments',
  'distinct',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
];

export function baseSchemaPlugin(schema: Schema): void {
  schema.add({ deletedAt: { type: Date, default: null } });
  schema.index({ deletedAt: 1 });

  schema.pre(QUERY_HOOKS as any, function (this: any) {
    if (this.getOptions()[WITH_DELETED]) return;
    if (Object.prototype.hasOwnProperty.call(this.getFilter(), 'deletedAt')) return;
    this.where({ deletedAt: null });
  });

  schema.pre('aggregate', function () {
    if ((this.options as Record<string, unknown>)[WITH_DELETED]) return;
    const pipeline = this.pipeline();
    const first = pipeline[0] as unknown as Record<string, unknown> | undefined;
    // $geoNear / $search / $vectorSearch must stay first; none are used here.
    if (first && ('$geoNear' in first || '$search' in first || '$vectorSearch' in first)) return;
    pipeline.unshift({ $match: { deletedAt: null } });
  });

  // Fields declared `select: false` (password hashes, token versions) are
  // never serialized, even if a query explicitly selected them.
  const hidden = Object.entries(schema.paths)
    .filter(([, type]) => (type as any).options?.select === false)
    .map(([path]) => path);

  const transform = (_doc: unknown, ret: Record<string, any>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    delete ret.deletedAt;
    for (const path of hidden) delete ret[path];
    return toPlain(ret);
  };
  schema.set('toJSON', { virtuals: false, versionKey: false, transform });
  schema.set('toObject', { virtuals: false, versionKey: false });
}

/** Recursively convert BSON types into JSON-friendly values. */
export function toPlain(value: any): any {
  if (value === null || value === undefined) return value;
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value instanceof Types.Decimal128) return Number(value.toString());
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (key === '_id' && value !== null && 'id' in value) continue;
      value[key] = toPlain(value[key]);
    }
    if ('_id' in value && !('id' in value)) {
      value.id = value._id;
      delete value._id;
    }
    return value;
  }
  return value;
}
