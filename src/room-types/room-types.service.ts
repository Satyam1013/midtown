import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { conflict, notFound } from '../common/errors';
import { toD128 } from '../common/utils/money';
import { TransactionService } from '../database/transaction.service';
import { Room, RoomStatus, SELLABLE_STATUSES } from '../rooms/schemas/room.schema';
import { RoomType } from './schemas/room-type.schema';

@Injectable()
export class RoomTypesService {
  constructor(
    @InjectModel(RoomType.name) private readonly types: Model<RoomType>,
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    private readonly tx: TransactionService,
  ) {}

  async list() {
    const types = await this.types.find().sort({ sortOrder: 1 }).lean();
    const [from, counts] = await Promise.all([this.lowestRates(), this.roomCounts()]);
    return types.map((t) => ({
      ...t,
      // Rooms under MAINTENANCE or OOO are not counted anywhere a room is sold.
      totalRooms: counts.get(String(t._id))?.sellable ?? 0,
      availableRooms: counts.get(String(t._id))?.free ?? 0,
      // Category types have no rack rate; show the cheapest room's single rate.
      tariff: t.tariff ?? from.get(String(t._id)) ?? null,
      // The guest app reads the number; `size` holds it as "180 sq ft".
      sizeSqft: Number.parseInt(t.size, 10) || null,
    }));
  }

  /** Per type: rooms that can be sold, and of those the ones free now (VACANT or DIRTY). */
  async roomCounts() {
    const rows = await this.rooms.aggregate<{ _id: Types.ObjectId; sellable: number; free: number }>([
      { $match: { deletedAt: null, status: { $in: SELLABLE_STATUSES } } },
      {
        $group: {
          _id: '$roomTypeId',
          sellable: { $sum: 1 },
          free: { $sum: { $cond: [{ $in: ['$status', [RoomStatus.VACANT, RoomStatus.DIRTY]] }, 1, 0] } },
        },
      },
    ]);
    return new Map(rows.map((r) => [String(r._id), r]));
  }

  /** Rejects a booking for more rooms of a type than can be sold. */
  async assertSellable(typeId: Types.ObjectId | string, rooms: number) {
    const sellable = (await this.roomCounts()).get(String(typeId))?.sellable ?? 0;
    if (rooms > sellable) {
      throw conflict('NO_ROOMS_AVAILABLE', sellable ? `Only ${sellable} room${sellable === 1 ? '' : 's'} of this type can be booked` : 'No rooms of this type can be booked right now');
    }
  }

  /** Lowest single rate per room type, from the rooms themselves. */
  async lowestRates() {
    const rows = await this.rooms.aggregate<{ _id: Types.ObjectId; rate: Types.Decimal128 }>([
      { $group: { _id: '$roomTypeId', rate: { $min: { $ifNull: ['$singleRate', '$rate'] } } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.rate]));
  }

  /** New tariff also applies to rooms on the old rate. Current stays keep the rate they agreed. */
  updateTariff(id: Types.ObjectId, tariff: string) {
    return this.tx.run(async ({ session }) => {
      const type = await this.types.findById(id).session(session);
      if (!type) throw notFound('Room type');
      const previous = type.tariff;
      type.tariff = toD128(tariff);
      await type.save({ session });
      if (previous) {
        // Rooms still on the old single rate follow the new tariff; custom-priced rooms don't.
        await this.rooms.updateMany(
          { roomTypeId: id, rate: previous },
          { $set: { rate: type.tariff, singleRate: type.tariff } },
          { session },
        );
        await this.rooms.updateMany({ roomTypeId: id, doubleRate: previous }, { $set: { doubleRate: type.tariff } }, { session });
      }
      return type;
    });
  }
}
