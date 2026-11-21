import { Global, Injectable, Module } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Booking, BookingStatus } from '../bookings/schemas/booking.schema';
import { conflict, notFound } from '../common/errors';
import { BusinessDateService } from '../common/services/business-date.service';
import { roomCapacity } from '../config/pricing';
import { BusinessDayStatus, DayBook } from '../daybook/schemas/day-book.schema';
import { EventsService } from '../notifications/events.service';
import { Stay, StayStatus } from '../stays/schemas/stay.schema';
import { Room, RoomStatus } from './schemas/room.schema';

/** Bookings that hold their room. REQUESTED, CANCELLED, NO_SHOW and checked-in ones don't. */
export const HOLDING = [BookingStatus.CONFIRMED, BookingStatus.ARRIVING];

const notAvailable = (message: string) => conflict('ROOM_NOT_AVAILABLE', message);

export interface HoldRequest {
  roomId: Types.ObjectId | string;
  /** When given, the room must be of this type. */
  roomTypeId?: Types.ObjectId | string | null;
  pax: number;
  arrivalDate: string;
  departureDate: string;
  /** The booking being edited, so it doesn't clash with itself. */
  exceptBookingId?: Types.ObjectId | string | null;
}

/**
 * A booking holds one room for [arrivalDate, departureDate): a departure on a
 * day is free for an arrival on the same day. On the hold's arrival day the
 * room shows PREBOOKED (only from VACANT; an occupied room stays OCCUPIED until
 * it is cleaned), and only the booked guest can be checked into it.
 */
@Injectable()
export class RoomHoldsService {
  constructor(
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(Booking.name) private readonly bookings: Model<Booking>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    @InjectModel(DayBook.name) private readonly days: Model<DayBook>,
    private readonly dates: BusinessDateService,
    private readonly events: EventsService,
  ) {}

  /** The open business day, else the calendar date. */
  async today(session?: ClientSession | null): Promise<string> {
    const open = await this.days.findOne({ status: BusinessDayStatus.OPEN }).select('businessDate').session(session ?? null).lean();
    return open?.businessDate ?? this.dates.today();
  }

  /**
   * Every rule for holding a room, inside the caller's transaction. Writes to the
   * room first, so two bookings racing for the same room conflict and retry.
   */
  async assertBookable(req: HoldRequest, session: ClientSession) {
    const room = await this.rooms.findOneAndUpdate({ _id: req.roomId }, { $inc: { holdRev: 1 } }, { new: true, session });
    if (!room) throw notFound('Room');
    const label = `Room ${room.number}`;
    if (req.roomTypeId && String(room.roomTypeId) !== String(req.roomTypeId)) throw notAvailable(`${label} is not of the chosen room type`);
    if (roomCapacity(room) < req.pax) throw notAvailable(`${label} sleeps at most ${roomCapacity(room)}`);
    if (room.status === RoomStatus.OOO) throw notAvailable(`${label} is out of order`);
    if (room.status === RoomStatus.MAINTENANCE && (!room.maintenanceUntil || room.maintenanceUntil > req.arrivalDate)) {
      throw notAvailable(`${label} is under maintenance${room.maintenanceUntil ? ` until ${room.maintenanceUntil}` : ''}`);
    }
    const stay = await this.stays
      .findOne({ roomId: room._id, status: StayStatus.IN_HOUSE, checkOut: { $gt: req.arrivalDate } })
      .select('checkOut')
      .session(session)
      .lean();
    if (stay) throw notAvailable(`${label} is occupied until ${stay.checkOut}`);
    await this.assertNoClash(room._id, room.number, req.arrivalDate, req.departureDate, req.exceptBookingId ?? null, session);
    return room;
  }

  /** No other holding booking of this room overlaps [from, to). Also used by check-in and room shifts. */
  async assertNoClash(roomId: Types.ObjectId | string, roomNumber: string, from: string, to: string, exceptBookingId: Types.ObjectId | string | null, session: ClientSession) {
    const clash = await this.bookings
      .findOne({
        roomId,
        status: { $in: HOLDING },
        arrivalDate: { $lt: to },
        departureDate: { $gt: from },
        ...(exceptBookingId ? { _id: { $ne: exceptBookingId } } : {}),
      })
      .select('guestName arrivalDate departureDate')
      .session(session)
      .lean();
    if (clash) {
      throw notAvailable(`Room ${roomNumber} is booked for ${clash.guestName} from ${clash.arrivalDate} to ${clash.departureDate}`);
    }
  }

  /**
   * Brings rooms' PREBOOKED status in line with their holds for today: VACANT →
   * PREBOOKED when a booking arriving by today holds it, PREBOOKED → VACANT when
   * none does. Other statuses are left alone.
   */
  async sync(roomIds: (Types.ObjectId | string | null | undefined)[], session: ClientSession | null, afterCommit?: (fn: () => void) => void) {
    const ids = [...new Set(roomIds.filter(Boolean).map(String))];
    if (!ids.length) return;
    const today = await this.today(session);
    const held = new Set(
      (
        await this.bookings
          .find({ roomId: { $in: ids }, status: { $in: HOLDING }, arrivalDate: { $lte: today }, departureDate: { $gt: today } })
          .select('roomId')
          .session(session)
          .lean()
      ).map((b) => String(b.roomId)),
    );
    const changed: { id: string; status: RoomStatus }[] = [];
    for (const id of ids) {
      const to = held.has(id) ? RoomStatus.PREBOOKED : RoomStatus.VACANT;
      const from = held.has(id) ? RoomStatus.VACANT : RoomStatus.PREBOOKED;
      const res = await this.rooms.updateOne({ _id: id, status: from }, { $set: { status: to } }, { session: session ?? undefined });
      if (res.modifiedCount) changed.push({ id, status: to });
    }
    const announce = () => changed.forEach((c) => this.events.toHotel('room.status.changed', { roomId: c.id, status: c.status }));
    if (afterCommit) afterCommit(announce);
    else announce();
  }

  /** Every room that is PREBOOKED or held today: run when a business day starts or closes. */
  async syncAll(session: ClientSession | null, afterCommit?: (fn: () => void) => void) {
    const today = await this.today(session);
    const [prebooked, held] = await Promise.all([
      this.rooms.find({ status: RoomStatus.PREBOOKED }).select('_id').session(session).lean(),
      this.bookings.find({ roomId: { $ne: null }, status: { $in: HOLDING }, arrivalDate: { $lte: today }, departureDate: { $gt: today } }).select('roomId').session(session).lean(),
    ]);
    await this.sync([...prebooked.map((r) => r._id), ...held.map((b) => b.roomId)], session, afterCommit);
  }

  /** Per room, the next holding booking that hasn't ended yet. */
  async nextHolds() {
    const today = await this.today();
    const rows = await this.bookings
      .find({ roomId: { $ne: null }, status: { $in: HOLDING }, departureDate: { $gt: today } })
      .sort({ arrivalDate: 1 })
      .select('roomId guestName arrivalDate departureDate pax status')
      .lean();
    const next = new Map<string, { id: Types.ObjectId; guestName: string; arrivalDate: string; departureDate: string; pax: number; status: string }>();
    for (const b of rows) {
      const key = String(b.roomId);
      if (!next.has(key)) next.set(key, { id: b._id, guestName: b.guestName, arrivalDate: b.arrivalDate, departureDate: b.departureDate, pax: b.pax, status: b.status });
    }
    return next;
  }

  /** Rooms that could take a booking for [from, to): the same rules as assertBookable. */
  async available(q: { from: string; to: string; roomTypeId?: string; guests?: number }) {
    const rooms = await this.rooms
      .find({ ...(q.roomTypeId ? { roomTypeId: q.roomTypeId } : {}), status: { $ne: RoomStatus.OOO } })
      .sort({ floor: 1, number: 1 })
      .lean();
    const [stays, clashes] = await Promise.all([
      this.stays.find({ roomId: { $in: rooms.map((r) => r._id) }, status: StayStatus.IN_HOUSE, checkOut: { $gt: q.from } }).select('roomId').lean(),
      this.bookings.find({ roomId: { $in: rooms.map((r) => r._id) }, status: { $in: HOLDING }, arrivalDate: { $lt: q.to }, departureDate: { $gt: q.from } }).select('roomId').lean(),
    ]);
    const busy = new Set([...stays.map((s) => String(s.roomId)), ...clashes.map((b) => String(b.roomId))]);
    return rooms
      .filter((r) => !busy.has(String(r._id)))
      .filter((r) => roomCapacity(r) >= (q.guests ?? 1))
      .filter((r) => r.status !== RoomStatus.MAINTENANCE || (r.maintenanceUntil && r.maintenanceUntil <= q.from))
      .map((r) => ({ id: r._id, number: r.number, floor: r.floor, roomTypeId: r.roomTypeId, category: r.category, status: r.status, sleeps: roomCapacity(r) }));
  }
}

@Global()
@Module({ providers: [RoomHoldsService], exports: [RoomHoldsService] })
export class RoomHoldsModule {}
