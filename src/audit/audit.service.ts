import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { AuditAction, AuditLog } from './schemas/audit-log.schema';

@Injectable()
export class AuditService {
  constructor(@InjectModel(AuditLog.name) private readonly logs: Model<AuditLog>) {}

  /** Written inside the caller's transaction, so the log matches what committed. */
  async record(
    action: AuditAction,
    stayId: Types.ObjectId,
    userId: Types.ObjectId,
    details: Record<string, unknown>,
    session: ClientSession,
  ) {
    await this.logs.create([{ action, stayId, userId, details }], { session });
  }
}
