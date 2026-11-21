import { normalizePhone } from '../common/utils/phone';
import { occupancyRate, splitGuests } from '../config/pricing';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { Stay } from '../stays/schemas/stay.schema';
import { HOLDING, RoomHoldsService } from '../rooms/room-holds.service';
import { Room } from '../rooms/schemas/room.schema';

/** Bookings sold by an OTA: the amount is what the OTA charged, not our price. */
const OTA_SOURCES = ['MakeMyTrip', 'Booking.com', 'Goibibo', 'Agoda', 'Airbnb'];
const MAX_BOOKING_ROOMS = 10;
const MAX_BOOKING_NIGHTS = 30;

type QuoteInput = { rooms: { roomTypeId: string; guests: number }[]; pax?: number | null; arrivalDate: string; departureDate: string };
type Priced = Awaited<ReturnType<BookingsService['priceLines']>>;
import { CustomersService } from '../customers/customers.service';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { pageOf } from '../common/dto/common.dto';
import { badRequest, conflict, notFound } from '../common/errors';
import { Paged } from '../common/interceptors/response.interceptor';
import { BusinessDateService } from '../common/services/business-date.service';
import { dec, toD128 } from '../common/utils/money';
import { CounterService } from '../database/counter.service';
import { TransactionService } from '../database/transaction.service';
import { EventsService } from '../notifications/events.service';
import { RoomTypesService } from '../room-types/room-types.service';
import { RoomType } from '../room-types/schemas/room-type.schema';
import { BookingQueryDto, CreateBookingDto, GuestBookingDto, UpdateBookingDto } from './dto/booking.dto';
import { Booking, BookingSource, BookingStatus } from './schemas/booking.schema';

@Injectable()
export class BookingsService {
  constructor(
    @InjectModel(Booking.name) private readonly bookings: Model<Booking>,
    @InjectModel(RoomType.name) private readonly types: Model<RoomType>,
    private readonly tx: TransactionService,
    private readonly counters: CounterService,
    private readonly dates: BusinessDateService,
    private readonly events: EventsService,
    private readonly roomTypes: RoomTypesService,
    private readonly customers: CustomersService,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    private readonly audit: AuditService,
    @InjectModel(Room.name) private readonly roomModel: Model<Room>,
    private readonly holds: RoomHoldsService,
  ) {}

  /** Soonest arrival first. */
  async list(q: BookingQueryDto) {
    const { page, limit, skip } = pageOf(q);
    if (q.from && q.to && q.to < q.from) throw badRequest('INVALID_RANGE', '`from` must not be after `to`');
    const status: Record<string, unknown> = {};
    if (q.status?.length) status.$in = q.status;
    if (q.excludeStatus?.length) status.$nin = q.excludeStatus;
    const arrival: Record<string, string> = {};
    if (q.date) arrival.$eq = q.date;
    if (q.from) arrival.$gte = q.from;
    if (q.to) arrival.$lte = q.to;
    const filter = { ...(Object.keys(status).length ? { status } : {}), ...(Object.keys(arrival).length ? { arrivalDate: arrival } : {}) };
    const [items, total] = await Promise.all([
      this.bookings.find(filter).sort({ arrivalDate: 1, createdAt: 1 }).skip(skip).limit(limit).lean(),
      this.bookings.countDocuments(filter),
    ]);
    return new Paged(await this.withRoomNumbers(items), { page, limit, total });
  }

  /** Adds roomNumber, as GET /bookings shows each booking. */
  private async withRoomNumbers<T extends { roomId?: Types.ObjectId | null }>(items: T[]) {
    const rooms = await this.roomModel.find({ _id: { $in: items.map((b) => b.roomId).filter(Boolean) } }).select('number').setOptions({ withDeleted: true }).lean();
    const numberOf = new Map(rooms.map((r) => [String(r._id), r.number]));
    return items.map((b) => ({ ...b, roomId: b.roomId ?? null, roomNumber: b.roomId ? (numberOf.get(String(b.roomId)) ?? null) : null }));
  }

  /**
   * Front desk. Priced on the server; an OTA booking keeps the amount the OTA charged.
   * With a room (always, from the desk app) the booking is for that one room, which
   * is checked and held in the same transaction: 409 ROOM_NOT_AVAILABLE.
   */
  async create(dto: Omit<CreateBookingDto, 'roomId' | 'rooms'> & { roomId?: string; rooms?: CreateBookingDto['rooms'] }) {
    let lines = dto.rooms;
    if (dto.roomId) {
      if (lines && lines.length > 1) throw badRequest('ONE_ROOM_ONLY', 'A booking with a room is for that one room');
      const room = await this.roomModel.findById(dto.roomId).lean();
      if (!room) throw notFound('Room');
      lines = [{ roomTypeId: String(room.roomTypeId), guests: dto.pax ?? lines?.[0]?.guests ?? 1 }];
    }
    if (!lines?.length) throw badRequest('ROOM_REQUIRED', 'Choose the room for this booking');
    const priced = await this.priceLines({ ...dto, rooms: lines, pax: dto.roomId ? null : dto.pax }, { maxNights: null });
    const ota = OTA_SOURCES.includes(dto.source);
    if (ota && dto.amount === undefined) throw badRequest('AMOUNT_REQUIRED', 'Enter the amount the OTA booking was sold for');
    try {
      const customerId = (await this.customers.byPhone(dto.phone, dto.guestName))?._id ?? null;
      const booking = await this.tx.run(async ({ session, afterCommit }) => {
        if (dto.roomId) {
          await this.holds.assertBookable(
            { roomId: dto.roomId, roomTypeId: dto.roomTypeId, pax: priced.pax, arrivalDate: dto.arrivalDate, departureDate: dto.departureDate },
            session,
          );
        }
        const [created] = await this.bookings.create(
          [
            {
              ...this.fieldsOf(dto),
              source: dto.source,
              status: BookingStatus.CONFIRMED,
              payment: dto.payment ?? '',
              ref: dto.ref || null,
              customerId,
              roomId: dto.roomId ?? null,
              ...this.linesOf(priced),
              amount: ota ? toD128(dto.amount!) : toD128(priced.amount),
            },
          ],
          { session },
        );
        await this.holds.sync([created.roomId], session, afterCommit);
        return created;
      });
      this.announce(booking);
      return booking;
    } catch (err: any) {
      if (err?.code === 11000) throw conflict('BOOKING_EXISTS', 'A booking with this source and reference already exists');
      throw err;
    }
  }

  /**
   * Guest app or public request, priced here. The booking belongs to
   * `customerId` (the signed-in booker) when given, else to the customer with its phone.
   */
  async createFromGuest(dto: GuestBookingDto, beforeCreate?: (session: ClientSession) => Promise<void>, customerId?: Types.ObjectId) {
    if (dto.arrivalDate < this.dates.today()) throw badRequest('INVALID_DATES', 'Arrival cannot be in the past');
    const priced = await this.priceLines(dto);
    const booking = await this.tx.run(async ({ session }) => {
      await beforeCreate?.(session);
      const seq = await this.counters.next('guest-booking', session);
      const owner = customerId ?? (await this.customers.byPhone(dto.phone, dto.guestName, session))?._id ?? null;
      const [created] = await this.bookings.create(
        [
          {
            ...this.fieldsOf(dto),
            customerId: owner,
            source: BookingSource.GuestApp,
            ref: `GA${String(seq).padStart(6, '0')}`,
            ...this.linesOf(priced),
            amount: toD128(priced.amount),
            status: BookingStatus.REQUESTED,
          },
        ],
        { session },
      );
      return created;
    });
    this.announce(booking);
    return { booking, priced };
  }

  /** The booking as the apps read it after creating it: one entry per room, numbers only. */
  static summary(booking: { _id: unknown; ref: string | null; status: string; amount: unknown; roomLines: any[] }, priced: Priced) {
    return {
      id: booking._id,
      ref: booking.ref,
      status: booking.status,
      amount: Number(String(booking.amount)),
      nights: priced.nights,
      rooms: booking.roomLines.map((l, i) => ({
        lineId: l._id,
        stayId: null,
        roomTypeId: l.roomTypeId,
        roomType: priced.lines[i]?.roomType ?? null,
        guests: l.guests,
        rate: Number(String(l.rate)),
      })),
    };
  }

  /** POST …/bookings/quote: the same pricing as a booking, nothing saved. */
  async quote(dto: QuoteInput) {
    const priced = await this.priceLines(dto);
    const rooms = priced.lines.map((l) => ({ roomTypeId: l.roomTypeId, roomType: l.roomType, guests: l.guests, ratePerNight: l.rate.toNumber() }));
    return { nights: priced.nights, rooms, perRoom: rooms, amount: priced.amount.toNumber(), gstIncluded: false };
  }

  /**
   * Occupancy pricing, per room line: 1 guest → single, 2 → double,
   * 3+ → double + (guests − 2) × additional. Each line keeps its room type's
   * prices so a later tariff change doesn't touch the booking.
   */
  async priceLines(dto: QuoteInput, opts: { maxNights?: number | null } = {}) {
    const lines = dto.rooms;
    if (lines.length > MAX_BOOKING_ROOMS) throw badRequest('BULK_BOOKING', 'For bulk booking, please contact the front desk.');
    this.assertDates(dto.arrivalDate, dto.departureDate);
    const nights = this.dates.daysBetween(dto.arrivalDate, dto.departureDate);
    // Guests book up to 30 nights; the front desk may take longer stays.
    const maxNights = opts.maxNights === undefined ? MAX_BOOKING_NIGHTS : opts.maxNights;
    if (maxNights !== null && nights > maxNights) throw badRequest('INVALID_DATES', `A stay must be between 1 and ${maxNights} nights`);
    if (dto.pax != null && dto.pax < lines.length) throw badRequest('TOO_FEW_GUESTS', 'Each room needs at least one guest');
    const pax = lines.reduce((t, l) => t + l.guests, 0);
    if (dto.pax !== undefined && dto.pax !== null && dto.pax !== pax) {
      throw badRequest('PAX_MISMATCH', `pax (${dto.pax}) must equal the guests in the rooms (${pax})`);
    }
    const cards = new Map<string, Awaited<ReturnType<RoomTypesService['rateCardFor']>>>();
    for (const id of new Set(lines.map((l) => String(l.roomTypeId)))) cards.set(id, await this.roomTypes.rateCardFor(id));
    const priced = lines.map((l) => {
      const { type, card } = cards.get(String(l.roomTypeId))!;
      if (l.guests > type.sleeps) {
        throw badRequest('TOO_MANY_GUESTS', `${type.name} sleeps ${type.sleeps} — max ${type.sleeps} guest${type.sleeps === 1 ? '' : 's'} per room`);
      }
      return { roomTypeId: type._id, roomType: type.name, guests: l.guests, rate: occupancyRate(card, l.guests), card };
    });
    for (const [id, { type }] of cards) {
      await this.roomTypes.assertSellable(type._id, lines.filter((l) => String(l.roomTypeId) === id).length);
    }
    const amount = priced.reduce((t, l) => t.plus(l.rate), dec(0)).times(nights);
    return { nights, pax, lines: priced, amount };
  }

  /** Booking fields common to every source. `rooms` (a count) and `roomTypeId` (the first line's) stay for older readers. */
  private fieldsOf(dto: { guestName: string; phone?: string; arrivalDate: string; departureDate: string; note?: string }) {
    return {
      guestName: dto.guestName.trim(),
      phone: normalizePhone(dto.phone),
      arrivalDate: dto.arrivalDate,
      departureDate: dto.departureDate,
      note: dto.note ?? '',
    };
  }

  private linesOf(priced: Priced) {
    const card = (c: Priced['lines'][number]['card']) => ({
      singleRate: toD128(c.singleRate),
      doubleRate: toD128(c.doubleRate),
      additionalGuestRate: toD128(c.additionalGuestRate),
    });
    return {
      roomTypeId: priced.lines[0].roomTypeId,
      rooms: priced.lines.length,
      pax: priced.pax,
      roomLines: priced.lines.map((l) => ({ roomTypeId: l.roomTypeId, guests: l.guests, rate: toD128(l.rate), rateCard: card(l.card), stayId: null })),
      rateCard: card(priced.lines[0].card),
    };
  }

  /**
   * Edit any field. Once a room of the booking is checked in, the fields that
   * shape the stay (arrival, rooms, room type, guests) are locked: 409 BOOKING_LOCKED.
   * Room type, rooms or guests reprice the booking at today's tariff; a date
   * change alone keeps each room's booked rate and only changes the nights.
   */
  async update(id: Types.ObjectId, dto: UpdateBookingDto, user: Principal) {
    try {
      const booking = await this.tx.run(async ({ session }) => {
        const b = await this.bookings.findById(id).session(session);
        if (!b) throw notFound('Booking');
        const before = b.toObject();
        const lines = b.roomLines;
        const oldRoomId = b.roomId;
        const roomChanged = dto.roomId !== undefined && dto.roomId !== String(b.roomId ?? '');
        const newRoomId = dto.roomId ?? (b.roomId ? String(b.roomId) : null);
        if (newRoomId) {
          if (dto.rooms !== undefined && dto.rooms > 1) throw badRequest('ONE_ROOM_ONLY', 'A booking with a room is for that one room');
          const room = await this.roomModel.findById(newRoomId).session(session).lean();
          if (!room) throw notFound('Room');
          // A new room brings its own type unless one was sent (which must then match).
          if (roomChanged && dto.roomTypeId === undefined) dto.roomTypeId = String(room.roomTypeId);
        }
        const typeChanged = dto.roomTypeId !== undefined && lines.some((l) => String(l.roomTypeId) !== dto.roomTypeId);
        const roomsChanged = dto.rooms !== undefined && dto.rooms !== lines.length;
        const paxChanged = dto.pax !== undefined && dto.pax !== b.pax;
        const arrivalChanged = dto.arrivalDate !== undefined && dto.arrivalDate !== b.arrivalDate;
        if (this.isClaimed(b) && (typeChanged || roomsChanged || paxChanged || arrivalChanged || roomChanged)) {
          throw conflict('BOOKING_LOCKED', 'A room of this booking is checked in: arrival, room, room type and guests can no longer change');
        }

        if (b.status === BookingStatus.NO_SHOW && dto.status && dto.status !== BookingStatus.NO_SHOW && dto.status !== BookingStatus.CANCELLED) {
          if (!arrivalChanged) throw badRequest('ARRIVAL_REQUIRED', 'Give the new arrival date for a guest who is coming late');
        }
        const arrivalDate = dto.arrivalDate ?? b.arrivalDate;
        const departureDate = dto.departureDate ?? b.departureDate;
        this.assertDates(arrivalDate, departureDate);
        const source = dto.source ?? b.source;
        let serverAmount = dec(String(b.amount));
        if (typeChanged || roomsChanged || paxChanged) {
          const count = dto.rooms ?? lines.length;
          const types = Array.from({ length: count }, (_, i) => dto.roomTypeId ?? String((lines[i] ?? lines[0]).roomTypeId));
          const guests = roomsChanged || paxChanged ? splitGuests(dto.pax ?? Math.max(b.pax, count), count) : lines.map((l) => l.guests);
          const priced = await this.priceLines(
            { rooms: types.map((roomTypeId, i) => ({ roomTypeId, guests: guests[i] })), pax: dto.pax ?? null, arrivalDate, departureDate },
            { maxNights: null },
          );
          b.set(this.linesOf(priced));
          serverAmount = priced.amount;
        } else if (dto.arrivalDate !== undefined || dto.departureDate !== undefined) {
          const nights = this.dates.daysBetween(arrivalDate, departureDate);
          serverAmount = lines.reduce((t, l) => t.plus(dec(String(l.rate))), dec(0)).times(nights);
        }
        const ota = OTA_SOURCES.includes(source);
        b.amount = toD128(ota ? (dto.amount ?? String(b.amount)) : serverAmount);

        b.set({ arrivalDate, departureDate, source });
        if (dto.ref !== undefined) b.ref = dto.ref?.trim() || null;
        if (dto.guestName !== undefined) b.guestName = dto.guestName.trim();
        if (dto.phone !== undefined) {
          b.phone = normalizePhone(dto.phone);
          // A guest-app booking stays with the customer who made it.
          if (b.source !== BookingSource.GuestApp) b.customerId = (await this.customers.byPhone(dto.phone, b.guestName, session))?._id ?? null;
        }
        if (dto.payment !== undefined) b.payment = dto.payment;
        if (dto.note !== undefined) b.note = dto.note;
        if (dto.status !== undefined) b.status = dto.status;

        // Hold the room again whenever what it is held for changed, or the booking comes back to life.
        const datesChanged = arrivalChanged || (dto.departureDate !== undefined && dto.departureDate !== before.departureDate);
        if (newRoomId && HOLDING.includes(b.status) && (roomChanged || typeChanged || roomsChanged || paxChanged || datesChanged || !HOLDING.includes(before.status))) {
          await this.holds.assertBookable(
            { roomId: newRoomId, roomTypeId: b.roomTypeId, pax: b.pax, arrivalDate: b.arrivalDate, departureDate: b.departureDate, exceptBookingId: b._id },
            session,
          );
        }
        b.roomId = newRoomId ? new Types.ObjectId(newRoomId) : null;
        await b.save({ session });
        await this.holds.sync([oldRoomId, b.roomId], session);

        const changed = Object.fromEntries(
          Object.keys(dto)
            .filter((k) => String((before as any)[k]) !== String((b as any)[k]))
            .map((k) => [k, { from: (before as any)[k] ?? null, to: (b as any)[k] ?? null }]),
        );
        await this.audit.record(AuditAction.BOOKING_UPDATE, null, userObjectId(user), { bookingId: String(id), ref: b.ref, changed }, session);
        return b;
      });
      this.events.toHotel('booking.updated', { id: String(booking._id), status: booking.status, source: booking.source });
      const [shown] = await this.withRoomNumbers([(await this.bookings.findById(id).lean())!]);
      return shown;
    } catch (err: any) {
      if (err?.code === 11000) throw conflict('BOOKING_EXISTS', 'A booking with this source and reference already exists');
      throw err;
    }
  }

  /**
   * Soft delete: gone from GET /bookings, kept for reports and the audit trail.
   * A booking with a checked-in room can only be cancelled: 409 BOOKING_IN_USE.
   */
  async remove(id: Types.ObjectId, user: Principal) {
    const booking = await this.tx.run(async ({ session }) => {
      const b = await this.bookings.findById(id).session(session);
      if (!b) throw notFound('Booking');
      if (this.isClaimed(b) || (await this.stays.exists({ bookingId: id }).session(session))) {
        throw conflict('BOOKING_IN_USE', 'This booking has a checked-in stay. Cancel it instead of deleting it.');
      }
      b.set('deletedAt', new Date());
      await b.save({ session });
      await this.holds.sync([b.roomId], session);
      await this.audit.record(
        AuditAction.BOOKING_DELETE,
        null,
        userObjectId(user),
        { bookingId: String(id), source: b.source, ref: b.ref, guestName: b.guestName, arrivalDate: b.arrivalDate, status: b.status, amount: b.amount },
        session,
      );
      return b;
    });
    this.events.toHotel('booking.deleted', { id: String(booking._id), status: booking.status, source: booking.source });
  }

  /** A room of the booking has been checked in. */
  private isClaimed(b: { status: BookingStatus; roomLines: { stayId: unknown }[] }) {
    return b.status === BookingStatus.CHECKED_IN || b.status === BookingStatus.CHECKED_OUT || b.roomLines.some((l) => l.stayId);
  }

  async setStatus(id: Types.ObjectId, status: BookingStatus) {
    const booking = await this.bookings.findByIdAndUpdate(id, { $set: { status } }, { new: true });
    if (!booking) throw notFound('Booking');
    await this.holds.sync([booking.roomId], null);
    return booking;
  }

  private announce(booking: { _id: unknown; status: BookingStatus; source: BookingSource }) {
    this.events.toHotel('booking.created', { id: String(booking._id), status: booking.status, source: booking.source });
  }

  private async requireType(id: string) {
    const type = await this.types.findById(id).lean();
    if (!type) throw notFound('Room type');
    return type;
  }

  private assertDates(arrival: string, departure: string) {
    if (!this.dates.isRealDate(arrival) || !this.dates.isRealDate(departure) || departure <= arrival) {
      throw badRequest('INVALID_DATES', 'Departure must be after arrival');
    }
  }
}
