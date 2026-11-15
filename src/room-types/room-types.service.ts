import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { badRequest, conflict, notFound } from '../common/errors';
import Decimal from 'decimal.js';
import { dec, toD128 } from '../common/utils/money';
import { RateCard } from '../config/pricing';
import { CreateRoomTypeDto, UpdateTariffDto } from './dto/room-type.dto';
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
    return types.map((t) => {
      const card = this.cardOf(t, from.get(String(t._id)));
      return {
        ...t,
        // Rooms under MAINTENANCE or OOO are not counted anywhere a room is sold.
        totalRooms: counts.get(String(t._id))?.sellable ?? 0,
        availableRooms: counts.get(String(t._id))?.free ?? 0,
        // Numbers, GST excluded. tariff = singleRate, kept for older apps.
        singleRate: card ? card.singleRate.toNumber() : null,
        doubleRate: card ? card.doubleRate.toNumber() : null,
        additionalGuestRate: card ? card.additionalGuestRate.toNumber() : 0,
        // Same value under the room's field name, for the guest booking screens.
        additionalGuestPrice: card ? card.additionalGuestRate.toNumber() : 0,
        tariff: card ? card.singleRate.toNumber() : null,
        // The guest app reads the number; `size` holds it as "180 sq ft".
        sizeSqft: Number.parseInt(t.size, 10) || null,
      };
    });
  }

  /**
   * A type's prices. Types from before occupancy pricing fall back to their
   * tariff, else their cheapest room; the double rate then equals the single.
   */
  cardOf(t: { singleRate?: Types.Decimal128 | null; doubleRate?: Types.Decimal128 | null; additionalGuestRate?: Types.Decimal128 | null; tariff?: Types.Decimal128 | null }, lowest?: Types.Decimal128 | null): RateCard | null {
    const single = t.singleRate ?? t.tariff ?? lowest ?? null;
    if (!single) return null;
    const s = dec(single);
    return { singleRate: s, doubleRate: Decimal.max(s, dec(t.doubleRate ?? single)), additionalGuestRate: dec(t.additionalGuestRate ?? 0) };
  }

  /** The type and its prices, for pricing a booking; 409 when the type has no price yet. */
  async rateCardFor(typeId: Types.ObjectId | string) {
    const type = await this.types.findById(typeId).lean();
    if (!type) throw notFound('Room type');
    const card = this.cardOf(type, type.singleRate || type.tariff ? null : (await this.lowestRates()).get(String(type._id)));
    if (!card) throw conflict('NO_PRICE', `${type.name} has no price yet`);
    return { type, card };
  }

  async create(dto: CreateRoomTypeDto) {
    this.assertRates(dto.singleRate, dto.doubleRate);
    if (await this.types.exists({ name: dto.name.trim() }).collation({ locale: 'en', strength: 2 })) {
      throw conflict('ROOM_TYPE_EXISTS', `${dto.name} already exists`);
    }
    return this.types.create({
      name: dto.name.trim(),
      category: dto.category ?? null,
      sleeps: dto.sleeps ?? 2,
      singleRate: toD128(dto.singleRate),
      doubleRate: toD128(dto.doubleRate),
      additionalGuestRate: toD128(dto.additionalGuestRate ?? '0'),
      tariff: toD128(dto.singleRate),
      beds: dto.beds ?? '',
      size: dto.size ?? '',
      blurb: dto.blurb ?? '',
      perks: dto.perks ?? [],
      photoUrl: null,
      sortOrder: dto.sortOrder ?? 100,
    });
  }

  private assertRates(single?: string | Types.Decimal128 | null, double?: string | Types.Decimal128 | null) {
    if (single && double && dec(double).lt(dec(single))) {
      throw badRequest('INVALID_RATES', 'The double rate must be at least the single rate');
    }
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

  /**
   * Prices and details. `tariff` is the old name for singleRate. Rooms still
   * on the old single/double price follow; custom-priced rooms and current
   * stays and bookings keep theirs.
   */
  updateTariff(id: Types.ObjectId, dto: UpdateTariffDto) {
    if (dto.tariff && dto.singleRate && dec(dto.tariff).cmp(dec(dto.singleRate)) !== 0) {
      throw badRequest('RATE_MISMATCH', 'tariff and singleRate must match; send singleRate only');
    }
    return this.tx.run(async ({ session }) => {
      const type = await this.types.findById(id).session(session);
      if (!type) throw notFound('Room type');
      const card = this.cardOf(type, (await this.lowestRates()).get(String(type._id)));
      const single = dto.singleRate ?? dto.tariff;
      const nextSingle = single ? dec(single) : card?.singleRate;
      const nextDouble = dto.doubleRate ? dec(dto.doubleRate) : (type.doubleRate ? dec(type.doubleRate) : nextSingle);
      if (!nextSingle) throw badRequest('INVALID_RATES', 'Set the single rate');
      this.assertRates(toD128(nextSingle), nextDouble ? toD128(nextDouble) : null);
      const previous = { single: type.singleRate ?? type.tariff, double: type.doubleRate ?? type.tariff };
      type.singleRate = toD128(nextSingle);
      type.tariff = type.singleRate;
      type.doubleRate = toD128(nextDouble ?? nextSingle);
      if (dto.additionalGuestRate !== undefined) type.additionalGuestRate = toD128(dto.additionalGuestRate);
      for (const k of ['sleeps', 'beds', 'size', 'blurb', 'perks', 'sortOrder'] as const) {
        if (dto[k] !== undefined) (type as any)[k] = dto[k];
      }
      await type.save({ session });
      if (previous.single && String(previous.single) !== String(type.singleRate)) {
        await this.rooms.updateMany({ roomTypeId: id, rate: previous.single }, { $set: { rate: type.singleRate, singleRate: type.singleRate } }, { session });
      }
      if (previous.double && String(previous.double) !== String(type.doubleRate)) {
        await this.rooms.updateMany({ roomTypeId: id, doubleRate: previous.double }, { $set: { doubleRate: type.doubleRate } }, { session });
      }
      return type;
    });
  }
}
