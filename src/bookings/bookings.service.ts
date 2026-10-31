import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { pageOf } from '../common/dto/common.dto';
import { badRequest, conflict, notFound } from '../common/errors';
import { Paged } from '../common/interceptors/response.interceptor';
import { BusinessDateService } from '../common/services/business-date.service';
import { dec, toD128 } from '../common/utils/money';
import { CounterService } from '../database/counter.service';
import { TransactionService } from '../database/transaction.service';
import { EventsService } from '../notifications/events.service';
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

  async create(dto: CreateBookingDto) {
    await this.requireType(dto.roomTypeId);
    this.assertDates(dto.arrivalDate, dto.departureDate);
    try {
      const booking = await this.bookings.create({
        ...dto,
        ref: dto.ref || null,
        amount: toD128(dto.amount),
        status: BookingStatus.CONFIRMED,
      });
      this.announce(booking);
      return booking;
    } catch (err: any) {
      if (err?.code === 11000) throw conflict('BOOKING_EXISTS', 'A booking with this source and reference already exists');
      throw err;
    }
  }

  /** Guest app request. The amount is worked out here from the tariff. */
  async createFromGuest(dto: GuestBookingDto) {
    const type = await this.requireType(dto.roomTypeId);
    this.assertDates(dto.arrivalDate, dto.departureDate);
    if (dto.arrivalDate < this.dates.today()) throw badRequest('INVALID_DATES', 'Arrival cannot be in the past');
    const nights = this.dates.daysBetween(dto.arrivalDate, dto.departureDate);
    const amount = dec(type.tariff).times(nights).times(dto.rooms);
    const booking = await this.tx.run(async ({ session }) => {
      const seq = await this.counters.next('guest-booking', session);
      const [created] = await this.bookings.create(
        [
          {
            ...dto,
            source: BookingSource.GuestApp,
            ref: `GA${String(seq).padStart(6, '0')}`,
            amount: toD128(amount),
            status: BookingStatus.REQUESTED,
          },
        ],
        { session },
      );
      return created;
    });
    this.announce(booking);
    return { booking };
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
