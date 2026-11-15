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
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { TransactionService } from '../database/transaction.service';
import { CreateRoomDto, SetRoomStatusDto, UpdateRoomDto } from './dto/room.dto';
import { RoomMaintenance } from './schemas/room-maintenance.schema';
import { Room, RoomCategory, RoomStatus } from './schemas/room.schema';

// Allowed manual moves. OCCUPIED and DIRTY only ever come from check-in / check-out.
const MANUAL_FROM: Partial<Record<RoomStatus, RoomStatus[]>> = {
  [RoomStatus.OOO]: [RoomStatus.VACANT, RoomStatus.DIRTY],
  [RoomStatus.VACANT]: [RoomStatus.DIRTY, RoomStatus.OOO, RoomStatus.MAINTENANCE],
  [RoomStatus.MAINTENANCE]: [RoomStatus.VACANT, RoomStatus.DIRTY],
};

const CLEAR_MAINTENANCE = { maintenanceReason: null, maintenanceUntil: null, maintenanceSince: null, maintenanceByUserId: null };

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
    @InjectModel(RoomMaintenance.name) private readonly maintenance: Model<RoomMaintenance>,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
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
        features: room.features ?? [],
        description: room.description ?? '',
        maintenanceReason: room.maintenanceReason ?? null,
        maintenanceUntil: room.maintenanceUntil ?? null,
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
      features: dto.features ?? [],
      description: dto.description?.trim() ?? '',
    });
  }

  /**
   * Room details, type and prices. Stays in progress keep the rate they were
   * charged: each stay holds its own rate and room-charge segments.
   */
  async update(id: Types.ObjectId, dto: UpdateRoomDto, user: Principal) {
    return this.tx.run(async ({ session }) => {
      const room = await this.rooms.findById(id).session(session);
      if (!room) throw notFound('Room');
      const before = { number: room.number, floor: room.floor, category: room.category, roomTypeId: room.roomTypeId, singleRate: room.singleRate ?? room.rate, doubleRate: room.doubleRate ?? room.rate };
      const changingType = dto.roomTypeId !== undefined || dto.roomType !== undefined;
      const type = changingType
        ? await this.resolveType(dto.roomTypeId, dto.roomType)
        : await this.types.findById(room.roomTypeId).session(session).lean();
      if (!type) throw notFound('Room type');
      const category = this.categoryFor(dto.category ?? (changingType ? undefined : room.category ?? undefined), type);

      if (dto.number !== undefined && dto.number !== room.number) {
        if (await this.stays.exists({ roomId: id }).setOptions({ withDeleted: true }).session(session)) {
          throw conflict('ROOM_HAS_STAYS', 'This room has stays on record, so its number can’t change');
        }
        if (await this.rooms.exists({ number: dto.number }).setOptions({ withDeleted: true }).session(session)) {
          throw conflict('ROOM_EXISTS', `Room ${dto.number} already exists`);
        }
        room.number = dto.number;
      }
      if (dto.floor !== undefined) room.floor = dto.floor;
      room.roomTypeId = type._id;
      room.category = category;
      const single = dto.singleRate ?? dto.rate;
      if (dto.singleRate && dto.rate && dto.singleRate !== dto.rate) {
        throw badRequest('RATE_MISMATCH', 'rate and singleRate must match; send singleRate only');
      }
      if (single !== undefined) {
        room.singleRate = toD128(single);
        room.rate = room.singleRate;
      }
      if (dto.doubleRate !== undefined) room.doubleRate = toD128(dto.doubleRate);
      // Older rooms get explicit rates the first time they're edited.
      room.singleRate ??= room.rate;
      room.doubleRate ??= room.rate;
      if (dto.features !== undefined) room.features = [...new Set(dto.features)];
      if (dto.description !== undefined) room.description = dto.description.trim();
      await room.save({ session });
      await this.audit.record(
        AuditAction.ROOM_UPDATE,
        null,
        userObjectId(user),
        {
          roomId: id,
          before,
          after: { number: room.number, floor: room.floor, category: room.category, roomTypeId: room.roomTypeId, singleRate: room.singleRate, doubleRate: room.doubleRate },
          priceChanged: String(before.singleRate) !== String(room.singleRate) || String(before.doubleRate) !== String(room.doubleRate),
        },
        session,
      );
      return room;
    });
  }

  /** Past and current maintenance periods, newest first. */
  maintenanceHistory(roomId?: string) {
    return this.maintenance.find(roomId ? { roomId } : {}).sort({ startedAt: -1 }).limit(500).lean();
  }

  async setStatus(id: Types.ObjectId, dto: SetRoomStatusDto, user: Principal) {
    const { status } = dto;
    const from = MANUAL_FROM[status];
    if (!from) {
      throw conflict('MANUAL_STATUS_NOT_ALLOWED', `${status} is set by check-in and check-out, not by hand`);
    }
    const room = await this.tx.run(async ({ session, afterCommit }) => {
      const current = await this.rooms.findById(id).session(session).lean();
      if (!current) throw notFound('Room');
      const toMaintenance = status === RoomStatus.MAINTENANCE;
      const set = toMaintenance
        ? {
            status,
            maintenanceReason: dto.reason?.trim() ?? '',
            maintenanceUntil: dto.expectedBackDate ?? null,
            maintenanceSince: new Date(),
            maintenanceByUserId: userObjectId(user),
          }
        : { status, ...CLEAR_MAINTENANCE };
      // Conditional, so it can't overwrite a check-in that happened a moment ago.
      const updated = await this.rooms.findOneAndUpdate({ _id: id, status: { $in: from } }, { $set: set }, { new: true, session });
      if (!updated) {
        if (current.status === RoomStatus.OCCUPIED) throw conflict('ROOM_OCCUPIED', 'A guest is in this room');
        throw conflict('INVALID_ROOM_STATUS', `This room can't move from ${current.status} to ${status}`);
      }
      if (toMaintenance) {
        await this.maintenance.create(
          [{ roomId: id, reason: set.maintenanceReason, expectedBackDate: set.maintenanceUntil, startedAt: new Date(), startedByUserId: userObjectId(user) }],
          { session },
        );
      } else if (current.status === RoomStatus.MAINTENANCE) {
        await this.maintenance.updateOne(
          { roomId: id, endedAt: null },
          { $set: { endedAt: new Date(), endedByUserId: userObjectId(user), endedTo: status } },
          { session },
        );
      }
      await this.audit.record(
        AuditAction.ROOM_STATUS,
        null,
        userObjectId(user),
        { roomId: id, from: current.status, to: status, reason: dto.reason ?? null, expectedBackDate: dto.expectedBackDate ?? null },
        session,
      );
      afterCommit(() => this.events.toHotel('room.status.changed', { roomId: String(updated._id), status: updated.status }));
      return updated;
    });
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
