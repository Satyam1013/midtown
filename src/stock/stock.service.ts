import { CreateStockItemDto, UpdateStockItemDto } from './dto/stock.dto';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
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
    private readonly audit: AuditService,
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
          await this.movements.create([{ stockItemId: created._id, delta: toD128Exact(qty), reason: 'Opening stock', userId: userObjectId(user), type: 'OPENING' }], { session });
        }
        return created;
      });
    } catch (err: any) {
      if (err?.code === 11000) throw taken();
      throw err;
    }
  }

  /**
   * Edit an item. A new qty is the stock level now: the difference is written as an
   * ADJUSTMENT movement in the same transaction, so the history still adds up.
   */
  async update(id: Types.ObjectId, dto: UpdateStockItemDto, user: Principal) {
    const name = dto.item?.trim();
    const taken = () => conflict('STOCK_ITEM_EXISTS', `${name} already exists in stock`);
    if (name && (await this.items.exists({ item: name, _id: { $ne: id } }).collation({ locale: 'en', strength: 2 }))) throw taken();
    try {
      return await this.tx.run(async ({ session }) => {
        const item = await this.items.findById(id).session(session);
        if (!item) throw notFound('Stock item');
        const before = { item: item.item, category: item.category, unit: item.unit, qty: item.qty, minQty: item.minQty, rate: item.rate };
        if (name) item.item = name;
        if (dto.category !== undefined) item.category = dto.category.trim();
        if (dto.unit !== undefined) item.unit = dto.unit.trim();
        if (dto.minQty !== undefined) item.minQty = toD128Exact(dto.minQty);
        if (dto.rate !== undefined) item.rate = toD128(dto.rate);
        let movement = null;
        if (dto.qty !== undefined) {
          const delta = dec(dto.qty).minus(dec(item.qty));
          if (!delta.isZero()) {
            item.qty = toD128Exact(dto.qty);
            [movement] = await this.movements.create(
              [{ stockItemId: id, delta: toD128Exact(delta), reason: 'Edited from inventory page', userId: userObjectId(user), type: 'ADJUSTMENT' }],
              { session },
            );
          }
        }
        await item.save({ session });
        await this.audit.record(AuditAction.STOCK_UPDATE, null, userObjectId(user), { stockItemId: String(id), before, changes: dto, movementId: movement?._id ?? null }, session);
        return this.items.findById(id).session(session).lean();
      });
    } catch (err: any) {
      if (err?.code === 11000) throw taken();
      throw err;
    }
  }

  /** Soft delete: gone from the list and low-stock checks; its movements stay. */
  async remove(id: Types.ObjectId, user: Principal) {
    await this.tx.run(async ({ session }) => {
      const item = await this.items.findById(id).session(session);
      if (!item) throw notFound('Stock item');
      item.set({ deletedAt: new Date(), deletedByUserId: userObjectId(user) });
      await item.save({ session });
      await this.audit.record(
        AuditAction.STOCK_DELETE,
        null,
        userObjectId(user),
        { stockItemId: String(id), item: item.item, category: item.category, unit: item.unit, lastQty: item.qty, rate: item.rate },
        session,
      );
    });
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
        [{ stockItemId: id, delta: toD128Exact(change), reason, userId: userObjectId(user), type: 'ADJUSTMENT' }],
        { session },
      );
      return { item, movement };
    });
  }
}
