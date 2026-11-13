import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import Decimal from 'decimal.js';
import { dec } from '../common/utils/money';
import { FolioLine } from './schemas/folio-line.schema';

@Injectable()
export class FolioService {
  constructor(@InjectModel(FolioLine.name) private readonly lines: Model<FolioLine>) {}

  /** Guest's bill. `paid` is money received net of refunds. */
  async summary(stayId: Types.ObjectId) {
    const lines = await this.lines.find({ stayId }).sort({ createdAt: 1 }).lean();
    const by: Record<string, Decimal> = { TARIFF: dec(0), FOOD: dec(0), OTHER: dec(0), PAYMENT: dec(0), REFUND: dec(0) };
    for (const line of lines) by[line.source] = (by[line.source] ?? dec(0)).plus(dec(line.amount));
    const total = by.TARIFF.plus(by.FOOD).plus(by.OTHER);
    // Payments are negative lines and refunds positive, so this is money received net of refunds.
    const paid = by.PAYMENT.plus(by.REFUND).negated();
    return {
      lines,
      total: total.toFixed(2),
      paid: paid.toFixed(2),
      balance: total.minus(paid).toFixed(2),
      // Checkout total = room charges (incl. 12% GST) + food (KOTs) + other charges − payments.
      breakdown: {
        roomCharges: by.TARIFF.toFixed(2),
        food: by.FOOD.toFixed(2),
        otherCharges: by.OTHER.toFixed(2),
        payments: paid.toFixed(2),
        total: total.minus(paid).toFixed(2),
      },
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
