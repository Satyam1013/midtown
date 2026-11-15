import { CreateStockItemDto } from './dto/stock.dto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { badRequest, conflict, notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { dec, toD128Exact, toD128 } from '../common/utils/money';
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

  /** A new item; an opening quantity is recorded as a movement so the history adds up. */
  async create(dto: CreateStockItemDto, user: Principal) {
    const item = dto.item.trim();
    const taken = () => conflict('STOCK_ITEM_EXISTS', `${item} already exists in stock`);
    if (await this.items.exists({ item }).collation({ locale: 'en', strength: 2 })) throw taken();
    const qty = dec(dto.qty ?? '0');
    try {
      return await this.tx.run(async ({ session }) => {
        const [created] = await this.items.create(
          [
            {
              item,
              category: dto.category.trim(),
              unit: dto.unit.trim(),
              qty: toD128Exact(qty),
              minQty: toD128Exact(dto.minQty ?? '0'),
              rate: toD128(dto.rate ?? '0'),
            },
          ],
          { session },
        );
        if (qty.gt(0)) {
          await this.movements.create([{ stockItemId: created._id, delta: toD128Exact(qty), reason: 'Opening stock', userId: userObjectId(user) }], { session });
        }
        return created;
      });
    } catch (err: any) {
      if (err?.code === 11000) throw taken();
      throw err;
    }
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
