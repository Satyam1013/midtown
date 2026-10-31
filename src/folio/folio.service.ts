import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { dec } from '../common/utils/money';
import { FolioLine } from './schemas/folio-line.schema';

@Injectable()
export class FolioService {
  constructor(@InjectModel(FolioLine.name) private readonly lines: Model<FolioLine>) {}

  /** Guest's bill. `paid` is money received net of refunds. */
  async summary(stayId: Types.ObjectId) {
    const lines = await this.lines.find({ stayId }).sort({ createdAt: 1 }).lean();
    let total = dec(0);
    let paid = dec(0);
    for (const line of lines) {
      const amount = dec(line.amount);
      if (line.source === 'PAYMENT' || line.source === 'REFUND') paid = paid.minus(amount);
      else total = total.plus(amount);
    }
    return {
      lines,
      total: total.toFixed(2),
      paid: paid.toFixed(2),
      balance: total.minus(paid).toFixed(2),
    };
  }

  /** Balance per stay, from a single aggregation. */
  async balances(stayIds: Types.ObjectId[], session?: ClientSession) {
    const rows = await this.lines
      .aggregate<{ _id: Types.ObjectId; balance: Types.Decimal128 }>([
        { $match: { stayId: { $in: stayIds } } },
        { $group: { _id: '$stayId', balance: { $sum: '$amount' } } },
      ])
      .session(session ?? null);
    return new Map(rows.map((r) => [String(r._id), r.balance]));
  }
}
