import { normalizePhone } from '../common/utils/phone';
import { occupancyRate } from '../config/pricing';

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
import { BookingQueryDto, CreateBookingDto, GuestBookingDto } from './dto/booking.dto';
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
  ) {}

  async list(q: BookingQueryDto) {
    const { page, limit, skip } = pageOf(q);
    const filter = { ...(q.status ? { status: q.status } : {}), ...(q.date ? { arrivalDate: q.date } : {}) };
    const [items, total] = await Promise.all([
      this.bookings.find(filter).sort({ arrivalDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.bookings.countDocuments(filter),
    ]);
    return new Paged(items, { page, limit, total });
  }

  /** Front desk. Priced on the server; an OTA booking keeps the amount the OTA charged. */
  async create(dto: CreateBookingDto) {
    const priced = await this.priceLines(dto, { maxNights: null });
    const ota = OTA_SOURCES.includes(dto.source);
    if (ota && dto.amount === undefined) throw badRequest('AMOUNT_REQUIRED', 'Enter the amount the OTA booking was sold for');
    try {
      const booking = await this.bookings.create({
        ...this.fieldsOf(dto),
        source: dto.source,
        status: BookingStatus.CONFIRMED,
        payment: dto.payment ?? '',
        ref: dto.ref || null,
        customerId: (await this.customers.byPhone(dto.phone, dto.guestName))?._id ?? null,
        ...this.linesOf(priced),
        amount: ota ? toD128(dto.amount!) : toD128(priced.amount),
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
  private fieldsOf(dto: GuestBookingDto | CreateBookingDto) {
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

  async setStatus(id: Types.ObjectId, status: BookingStatus) {
    const booking = await this.bookings.findByIdAndUpdate(id, { $set: { status } }, { new: true });
    if (!booking) throw notFound('Booking');
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
