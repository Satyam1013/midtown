import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Role } from '../common/enums';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { oidOrNull } from '../common/pipes/parse-object-id.pipe';
import { BusinessDateService } from '../common/services/business-date.service';
import { TaxService } from '../common/services/tax.service';
import { dec, toD128 } from '../common/utils/money';
import { normalizePhone } from '../common/utils/phone';
import { Booking, BookingStatus } from '../bookings/schemas/booking.schema';
import { DaybookService } from '../daybook/daybook.service';
import { TransactionService } from '../database/transaction.service';
import { DebitCredit } from '../common/enums';
import { LedgerService } from '../entries/ledger.service';
import { FolioService } from '../folio/folio.service';
import { FolioLine, FolioSource } from '../folio/schemas/folio-line.schema';
import { EventsService } from '../notifications/events.service';
import { Room, RoomStatus } from '../rooms/schemas/room.schema';
import { CheckInDto, CheckOutDto, StayPaymentDto, StayPaymentKind, UpdateStayDto } from './dto/stay.dto';
import { Stay, StayStatus } from './schemas/stay.schema';

const PAYMENT_TYPE: Record<StayPaymentKind, string> = {
  [StayPaymentKind.ADVANCE]: 'Advance',
  [StayPaymentKind.PART_PAYMENT]: 'Part payment',
  [StayPaymentKind.REFUND]: 'Refund',
};

@Injectable()
export class StaysService {
  constructor(
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(FolioLine.name) private readonly folioLines: Model<FolioLine>,
    @InjectModel(Booking.name) private readonly bookings: Model<Booking>,
    private readonly tx: TransactionService,
    private readonly ledger: LedgerService,
    private readonly daybook: DaybookService,
    private readonly folio: FolioService,
    private readonly dates: BusinessDateService,
    private readonly tax: TaxService,
    private readonly events: EventsService,
  ) {}

  async checkIn(dto: CheckInDto, user: Principal) {
    const checkIn = dto.businessDate ?? this.dates.today();
    this.dates.assertAllowed(checkIn, user);
    const { checkOut, nights } = this.stayLength(checkIn, dto.checkOut, dto.nights);

    return this.tx.run(async ({ session, afterCommit }) => {
      // The status flip is the lock: of two simultaneous check-ins only one can match VACANT.
      const room = await this.rooms.findOneAndUpdate(
        { _id: dto.roomId, status: RoomStatus.VACANT },
        { $set: { status: RoomStatus.OCCUPIED } },
        { new: true, session },
      );
      if (!room) {
        if (!(await this.rooms.exists({ _id: dto.roomId }).session(session))) throw notFound('Room');
        throw conflict('ROOM_NOT_VACANT', 'This room is not vacant');
      }

      if (dto.rate && !dec(dto.rate).equals(dec(room.rate)) && user.role !== Role.OWNER) {
        throw forbidden('RATE_OVERRIDE_FORBIDDEN', "Only the owner can check in at a different rate");
      }
      const rate = dto.rate ? toD128(dto.rate) : room.rate;

      const [stay] = await this.stays.create(
        [
          {
            roomId: room._id,
            guestName: dto.guestName.trim(),
            phone: normalizePhone(dto.phone),
            vehicle: dto.vehicle || null,
            checkIn,
            checkOut,
            nights,
            rate,
            bookingId: oidOrNull(dto.bookingId),
          },
        ],
        { session },
      );
      await this.folioLines.create(
        [{ stayId: stay._id, source: FolioSource.TARIFF, ...this.tariffLine(room.number, rate, nights) }],
        { session },
      );
      if (dto.bookingId) {
        await this.bookings.updateOne({ _id: dto.bookingId }, { $set: { status: BookingStatus.CHECKED_IN } }, { session });
      }

      afterCommit(() => {
        this.events.toHotel('room.status.changed', { roomId: String(room._id), status: room.status });
        this.events.toHotelAndStay('stay.updated', stay._id, { stayId: String(stay._id) });
      });
      return { stay };
    });
  }

  /** Edit a stay, with at most one advance, part payment or refund. */
  async update(id: Types.ObjectId, dto: UpdateStayDto, user: Principal) {
    if (dto.payment) this.dates.assertAllowed(dto.payment.businessDate, user);
    const current = await this.stays.findById(id).lean();
    if (!current) throw notFound('Stay');
    if (current.status !== StayStatus.IN_HOUSE) throw conflict('STAY_NOT_IN_HOUSE', 'This stay has already checked out');

    const work = () =>
      this.tx.run(async ({ session, afterCommit }) => {
        const stay = await this.stays.findOne({ _id: id, status: StayStatus.IN_HOUSE }).session(session);
        if (!stay) throw conflict('STAY_NOT_IN_HOUSE', 'This stay has already checked out');
        const room = await this.rooms.findById(stay.roomId).session(session);

        if (dto.guestName !== undefined) stay.guestName = dto.guestName.trim();
        if (dto.phone !== undefined) stay.phone = normalizePhone(dto.phone);
        if (dto.vehicle !== undefined) stay.vehicle = dto.vehicle || null;
        if (dto.checkOut !== undefined && dto.checkOut !== stay.checkOut) {
          const { checkOut, nights } = this.stayLength(stay.checkIn, dto.checkOut);
          stay.checkOut = checkOut;
          stay.nights = nights;
          await this.folioLines.updateOne(
            { stayId: stay._id, source: FolioSource.TARIFF },
            { $set: this.tariffLine(room!.number, stay.rate, nights) },
            { session },
          );
        }
        await stay.save({ session });

        let entry = null;
        if (dto.payment) entry = await this.postPayment(stay, room!.number, dto.payment, user, session);

        afterCommit(() => {
          this.events.toHotelAndStay('stay.updated', stay._id, { stayId: String(stay._id) });
          this.events.toHotelAndStay('folio.updated', stay._id, { stayId: String(stay._id) });
          if (entry) this.events.toHotel('entry.created', { id: String(entry._id), businessDate: entry.businessDate });
        });
        return { stay, entry };
      });

    if (!dto.payment) return work();
    return this.ledger.withDuplicateGuard(
      {
        businessDate: dto.payment.businessDate,
        roomId: current.roomId,
        type: PAYMENT_TYPE[dto.payment.kind],
        amount: dto.payment.amount,
        guestName: dto.guestName ?? current.guestName,
      },
      work,
    );
  }

  async checkOut(id: Types.ObjectId, dto: CheckOutDto, user: Principal) {
    if (dto.businessDate) this.dates.assertAllowed(dto.businessDate, user);
    const result = await this.tx.run(async ({ session, afterCommit }) => {
      const stay = await this.stays.findOneAndUpdate(
        { _id: id, status: StayStatus.IN_HOUSE },
        { $set: { status: StayStatus.CHECKED_OUT, checkedOutAt: new Date() } },
        { new: true, session },
      );
      if (!stay) {
        if (!(await this.stays.exists({ _id: id }).session(session))) throw notFound('Stay');
        throw conflict('STAY_NOT_IN_HOUSE', 'This stay has already checked out');
      }
      const room = await this.rooms.findByIdAndUpdate(
        stay.roomId,
        { $set: { status: RoomStatus.DIRTY } },
        { new: true, session },
      );
      afterCommit(() => {
        this.events.toHotel('room.status.changed', { roomId: String(stay.roomId), status: room?.status });
        this.events.toHotelAndStay('stay.updated', stay._id, { stayId: String(stay._id), status: stay.status });
        this.events.endStay(stay._id);
      });
      return stay;
    });
    const { balance } = await this.folio.summary(result._id);
    return { stay: result, folioBalance: balance };
  }

  async inHouse() {
    const stays = await this.stays.find({ status: StayStatus.IN_HOUSE }).sort({ checkIn: 1 }).lean();
    const rooms = await this.rooms.find({ _id: { $in: stays.map((s) => s.roomId) } }).lean();
    const balances = await this.folio.balances(stays.map((s) => s._id));
    const roomById = new Map(rooms.map((r) => [String(r._id), r]));
    return stays.map((stay) => ({
      ...stay,
      balance: balances.get(String(stay._id)) ?? toD128('0'),
      room: roomById.get(String(stay.roomId)) ?? null,
    }));
  }

  private postPayment(stay: any, roomNumber: string, p: StayPaymentDto, user: Principal, session: ClientSession) {
    const type = PAYMENT_TYPE[p.kind];
    const isRefund = p.kind === StayPaymentKind.REFUND;
    return this.daybook.touchOpenDay(p.businessDate, user, session).then(async () => {
      const key = { businessDate: p.businessDate, roomId: stay.roomId, type, amount: p.amount, guestName: stay.guestName };
      const duplicate = await this.ledger.findDuplicate(key, session);
      if (duplicate) throw this.ledger.duplicateError(duplicate._id);
      return this.ledger.post(
        {
          businessDate: p.businessDate,
          time: p.time,
          roomId: stay.roomId,
          stayId: stay._id,
          guestName: stay.guestName,
          phone: stay.phone,
          vehicle: stay.vehicle,
          type,
          mode: p.mode,
          dc: isRefund ? DebitCredit.DEBIT : DebitCredit.CREDIT,
          amount: p.amount,
          narration: p.narration ?? `${type}, room ${roomNumber}`,
          createdByUserId: userObjectId(user),
          folio: { head: type, source: isRefund ? FolioSource.REFUND : FolioSource.PAYMENT },
        },
        session,
      );
    });
  }

  /** One line holding tariff + 12% GST, kept in step when the stay's dates change. */
  private tariffLine(roomNumber: string, rate: unknown, nights: number) {
    const taxable = dec(rate as string).times(nights);
    return {
      head: `Room ${roomNumber}: ${nights} night${nights === 1 ? '' : 's'} + 12% GST`,
      amount: toD128(this.tax.room(taxable).total),
    };
  }

  /** The dates decide when they make sense; otherwise the night count does. */
  private stayLength(checkIn: string, checkOut?: string, nights?: number) {
    if (checkOut) {
      if (!this.dates.isRealDate(checkOut)) throw badRequest('INVALID_DATE', 'Check-out must be a real date');
      const span = this.dates.daysBetween(checkIn, checkOut);
      if (span >= 1) return { checkOut, nights: span };
      if (!nights) throw badRequest('INVALID_STAY_DATES', 'Check-out must be after check-in');
    }
    const count = nights ?? 1;
    return { checkOut: this.dates.addDays(checkIn, count), nights: count };
  }
}
