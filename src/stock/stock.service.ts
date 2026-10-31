import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { badRequest, conflict, notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { dec, toD128Exact } from '../common/utils/money';
import { TransactionService } from '../database/transaction.service';
import { StockItem } from './schemas/stock-item.schema';
import { StockMovement } from './schemas/stock-movement.schema';

@Injectable()
export class StockService {
  constructor(
    @InjectModel(StockItem.name) private readonly items: Model<StockItem>,
    @InjectModel(StockMovement.name) private readonly movements: Model<StockMovement>,
    private readonly tx: TransactionService,
  ) {}

  list() {
    return this.items.find().sort({ category: 1, item: 1 }).lean();
  }

  adjust(id: Types.ObjectId, delta: string, reason: string, user: Principal) {
    const change = dec(delta);
    if (change.isZero()) throw badRequest('INVALID_DELTA', 'The adjustment cannot be zero');
    return this.tx.run(async ({ session }) => {
      // $inc with a floor in the filter, so concurrent issues can't go below zero.
      const filter = change.isNegative()
        ? { _id: id, qty: { $gte: toD128Exact(change.negated()) } }
        : { _id: id };
      const item = await this.items.findOneAndUpdate(filter, { $inc: { qty: toD128Exact(change) } }, { new: true, session });
      if (!item) {
        if (!(await this.items.exists({ _id: id }).session(session))) throw notFound('Stock item');
        throw conflict('INSUFFICIENT_STOCK', 'Not enough stock for this adjustment');
      }
      const [movement] = await this.movements.create(
        [{ stockItemId: id, delta: toD128Exact(change), reason, userId: userObjectId(user) }],
        { session },
      );
      return { item, movement };
    });
  }
}
