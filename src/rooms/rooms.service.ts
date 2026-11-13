import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { badRequest, conflict, notFound } from '../common/errors';
import { toD128 } from '../common/utils/money';
import { doubleRateOf, singleRateOf } from '../config/pricing';
import { FolioService } from '../folio/folio.service';
import { EventsService } from '../notifications/events.service';
import { RoomType } from '../room-types/schemas/room-type.schema';
import { Stay, StayStatus } from '../stays/schemas/stay.schema';
import { StayViewService } from '../stays/stay-view.service';
import { CreateRoomDto, UpdateRoomDto } from './dto/room.dto';
import { Room, RoomCategory, RoomStatus } from './schemas/room.schema';

// Allowed manual moves. OCCUPIED and DIRTY only ever come from check-in / check-out.
const MANUAL_FROM: Partial<Record<RoomStatus, RoomStatus[]>> = {
  [RoomStatus.OOO]: [RoomStatus.VACANT, RoomStatus.DIRTY],
  [RoomStatus.VACANT]: [RoomStatus.DIRTY, RoomStatus.OOO],
};

const COLLATION = { locale: 'en', strength: 2 };

@Injectable()
export class RoomsService {
  constructor(
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(RoomType.name) private readonly types: Model<RoomType>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    private readonly folio: FolioService,
    private readonly stayView: StayViewService,
    private readonly events: EventsService,
  ) {}

  /** All rooms with their type, prices and current stay, in the shape the manager app reads. */
  async list() {
    const [rooms, types, stays] = await Promise.all([
      this.rooms.find().sort({ floor: 1, number: 1 }).lean(),
      this.types.find().lean(),
      this.stays.find({ status: StayStatus.IN_HOUSE }).lean(),
    ]);
    const [balances, decorated] = await Promise.all([
      this.folio.balances(stays.map((s) => s._id)),
      this.stayView.decorate(stays),
    ]);
    const typeById = new Map(types.map((t) => [String(t._id), t]));
    const stayByRoom = new Map(decorated.map((s) => [String(s.roomId), s]));
    return rooms.map((room) => {
      const type = typeById.get(String(room.roomTypeId));
      const stay = stayByRoom.get(String(room._id));
      return {
        ...room,
        category: room.category ?? type?.category ?? null,
        // Older rooms have only `rate`; it stands in for both until the manager sets them.
        singleRate: toD128(singleRateOf(room)),
        doubleRate: toD128(doubleRateOf(room)),
        roomType: type ? { id: type._id, name: type.name, category: type.category ?? null, tariff: type.tariff } : null,
        currentStay: stay ? { ...stay, balance: balances.get(String(stay._id)) ?? toD128('0') } : null,
      };
    });
  }

  async create(dto: CreateRoomDto) {
    const type = await this.resolveType(dto.roomTypeId, dto.roomType);
    const category = this.categoryFor(dto.category, type);
    let single: string;
    let double: string;
    if (dto.category) {
      // The category form must price both occupancies explicitly.
      if (!dto.singleRate || !dto.doubleRate) {
        throw badRequest('RATES_REQUIRED', 'Set both the single and the double rate');
      }
      single = dto.singleRate;
      double = dto.doubleRate;
    } else {
      // Legacy body: one rate, used for both until the manager sets them.
      const legacy = dto.singleRate ?? dto.rate ?? type.tariff?.toString();
      if (!legacy) throw badRequest('RATES_REQUIRED', 'Set the room rate');
      single = legacy;
      double = dto.doubleRate ?? legacy;
    }
    if (await this.rooms.exists({ number: dto.number }).setOptions({ withDeleted: true })) {
      throw conflict('ROOM_EXISTS', `Room ${dto.number} already exists`);
    }
    return this.rooms.create({
      number: dto.number,
      floor: dto.floor,
      roomTypeId: type._id,
      category,
      singleRate: toD128(single),
      doubleRate: toD128(double),
      rate: toD128(single),
    });
  }

  /** Category, type and prices. Stays in progress keep the rates they were charged. */
  async update(id: Types.ObjectId, dto: UpdateRoomDto) {
    const room = await this.rooms.findById(id);
    if (!room) throw notFound('Room');
    const changingType = dto.roomTypeId !== undefined || dto.roomType !== undefined;
    const type = changingType
      ? await this.resolveType(dto.roomTypeId, dto.roomType)
      : await this.types.findById(room.roomTypeId).lean();
    if (!type) throw notFound('Room type');
    const category = this.categoryFor(dto.category ?? (changingType ? undefined : room.category ?? undefined), type);

    room.roomTypeId = type._id;
    room.category = category;
    if (dto.singleRate !== undefined) {
      room.singleRate = toD128(dto.singleRate);
      room.rate = room.singleRate;
    }
    if (dto.doubleRate !== undefined) room.doubleRate = toD128(dto.doubleRate);
    // Older rooms get explicit rates the first time they're edited.
    room.singleRate ??= room.rate;
    room.doubleRate ??= room.rate;
    await room.save();
    return room;
  }

  async setStatus(id: Types.ObjectId, status: RoomStatus) {
    const from = MANUAL_FROM[status];
    if (!from) {
      throw conflict('MANUAL_STATUS_NOT_ALLOWED', `${status} is set by check-in and check-out, not by hand`);
    }
    // Conditional, so it can't overwrite a check-in that happened a moment ago.
    const room = await this.rooms.findOneAndUpdate({ _id: id, status: { $in: from } }, { $set: { status } }, { new: true });
    if (!room) {
      if (!(await this.rooms.exists({ _id: id }))) throw notFound('Room');
      throw conflict('INVALID_ROOM_STATUS', `This room can't move to ${status} right now`);
    }
    this.events.toHotel('room.status.changed', { roomId: String(room._id), status: room.status });
    return room;
  }

  async markAllClean() {
    const dirty = await this.rooms.find({ status: RoomStatus.DIRTY }).select('_id').lean();
    const res = await this.rooms.updateMany({ status: RoomStatus.DIRTY }, { $set: { status: RoomStatus.VACANT } });
    for (const r of dirty) {
      this.events.toHotel('room.status.changed', { roomId: String(r._id), status: RoomStatus.VACANT });
    }
    return { updated: res.modifiedCount };
  }

  private async resolveType(id?: string, name?: string) {
    if (!id && !name) throw badRequest('ROOM_TYPE_REQUIRED', 'Choose a room type');
    const byId = id ? await this.types.findById(id).lean() : null;
    const byName = name ? await this.types.findOne({ name: name.trim() }).collation(COLLATION).lean() : null;
    if ((id && !byId) || (name && !byName)) throw notFound('Room type');
    if (byId && byName && String(byId._id) !== String(byName._id)) {
      throw badRequest('ROOM_TYPE_MISMATCH', 'roomType and roomTypeId name different types');
    }
    return (byId ?? byName)!;
  }

  /** A category must match the type's: e.g. "AC Deluxe" can't be NON_AC. */
  private categoryFor(requested: RoomCategory | undefined, type: { name: string; category?: RoomCategory | null }) {
    if (requested && type.category !== requested) {
      throw badRequest('TYPE_CATEGORY_MISMATCH', `${type.name} is not a ${requested === RoomCategory.AC ? 'AC' : 'Non AC'} room type`);
    }
    return requested ?? type.category ?? null;
  }
}
