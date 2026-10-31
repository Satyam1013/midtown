import { Injectable, PipeTransform } from '@nestjs/common';
import { Types } from 'mongoose';
import { badRequest } from '../errors';

@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, Types.ObjectId> {
  transform(value: string): Types.ObjectId {
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{24}$/.test(value)) {
      throw badRequest('INVALID_ID', 'Invalid id');
    }
    return new Types.ObjectId(value);
  }
}

export const oid = (value: string | Types.ObjectId) => new Types.ObjectId(value);
export const oidOrNull = (value?: string | null) => (value ? new Types.ObjectId(value) : null);
