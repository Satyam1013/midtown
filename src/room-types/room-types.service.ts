import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { notFound } from '../common/errors';
import { toD128 } from '../common/utils/money';
import { TransactionService } from '../database/transaction.service';
import { Room } from '../rooms/schemas/room.schema';
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
    const from = await this.lowestRates();
    return types.map((t) => ({
      ...t,
      // Category types have no rack rate; show the cheapest room's single rate.
      tariff: t.tariff ?? from.get(String(t._id)) ?? null,
      // The guest app reads the number; `size` holds it as "180 sq ft".
      sizeSqft: Number.parseInt(t.size, 10) || null,
    }));
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
