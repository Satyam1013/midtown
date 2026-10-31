import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Types } from 'mongoose';
import { map } from 'rxjs';
import { HOIST_DATA } from '../decorators';

/** Return this from a service to set meta on the response. */
export class Paged<T> {
  constructor(
    readonly items: T[],
    readonly meta: { page: number; limit: number; total: number },
  ) {}
}

const NEVER_SERIALIZED = new Set(['deletedAt', '__v', 'passwordHash', 'tokenVersion', 'codeHash']);

/** Mongoose docs, lean objects and `{ stay, room }` wrappers all become plain JSON values. */
export function serialize(value: any): any {
  if (value === null || value === undefined) return value;
  if (value.$__ !== undefined) return serialize(value.toJSON());
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value instanceof Types.Decimal128) return Number(value.toString());
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!NEVER_SERIALIZED.has(key)) out[key === '_id' ? 'id' : key] = serialize(v);
  }
  return out;
}

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    const hoist = this.reflector.get<boolean>(HOIST_DATA, ctx.getHandler());
    return next.handle().pipe(
      map((result) => {
        if (result instanceof StreamableFile) return result;
        if (result instanceof Paged) return { data: serialize(result.items), meta: result.meta };
        const data = serialize(result);
        return hoist ? { ...data, data, meta: {} } : { data, meta: {} };
      }),
    );
  }
}
