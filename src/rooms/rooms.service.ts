import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { conflict, notFound } from '../common/errors';
import { oid } from '../common/pipes/parse-object-id.pipe';
import { toD128 } from '../common/utils/money';
import { FolioService } from '../folio/folio.service';
import { EventsService } from '../notifications/events.service';
import { RoomType } from '../room-types/schemas/room-type.schema';
import { Stay, StayStatus } from '../stays/schemas/stay.schema';
import { CreateRoomDto } from './dto/room.dto';
import { Room, RoomStatus } from './schemas/room.schema';

// Allowed manual moves. OCCUPIED and DIRTY only ever come from check-in / check-out.
const MANUAL_FROM: Partial<Record<RoomStatus, RoomStatus[]>> = {
  [RoomStatus.OOO]: [RoomStatus.VACANT, RoomStatus.DIRTY],
  [RoomStatus.VACANT]: [RoomStatus.DIRTY, RoomStatus.OOO],
};

@Injectable()
export class RoomsService {
  constructor(
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(RoomType.name) private readonly types: Model<RoomType>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    private readonly folio: FolioService,
    private readonly events: EventsService,
  ) {}

  /** All rooms with their type and current stay, in the shape the manager app reads. */
  async list() {
    const [rooms, types, stays] = await Promise.all([
      this.rooms.find().sort({ floor: 1, number: 1 }).lean(),
      this.types.find().lean(),
      this.stays.find({ status: StayStatus.IN_HOUSE }).lean(),
    ]);
    const balances = await this.folio.balances(stays.map((s) => s._id));
    const typeById = new Map(types.map((t) => [String(t._id), t]));
    const stayByRoom = new Map(stays.map((s) => [String(s.roomId), s]));
    return rooms.map((room) => {
      const type = typeById.get(String(room.roomTypeId));
      const stay = stayByRoom.get(String(room._id));
      return {
        ...room,
        roomType: type ? { id: type._id, name: type.name, tariff: type.tariff } : null,
        currentStay: stay ? { ...stay, balance: balances.get(String(stay._id)) ?? toD128('0') } : null,
      };
    });
  }

  async create(dto: CreateRoomDto) {
    const type = await this.types.findById(dto.roomTypeId).lean();
    if (!type) throw notFound('Room type');
    if (await this.rooms.exists({ number: dto.number }).setOptions({ withDeleted: true })) {
      throw conflict('ROOM_EXISTS', `Room ${dto.number} already exists`);
    }
    return this.rooms.create({
      number: dto.number,
      floor: dto.floor,
      roomTypeId: type._id,
      rate: dto.rate ? toD128(dto.rate) : type.tariff,
    });
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
      this.events.toHotel('room.status.changed', { roomId: String(oid(r._id)), status: RoomStatus.VACANT });
    }
    return { updated: res.modifiedCount };
  }
}
