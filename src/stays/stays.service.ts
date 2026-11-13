import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { Booking, BookingStatus } from '../bookings/schemas/booking.schema';
import { DebitCredit } from '../common/enums';
import { badRequest, conflict, notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { oidOrNull } from '../common/pipes/parse-object-id.pipe';
import { BusinessDateService } from '../common/services/business-date.service';
import { TaxService } from '../common/services/tax.service';
import { dec, toD128 } from '../common/utils/money';
import { normalizePhone } from '../common/utils/phone';
import { nightlyRate } from '../config/pricing';
import { DaybookService } from '../daybook/daybook.service';
import { TransactionService } from '../database/transaction.service';
import { LedgerService } from '../entries/ledger.service';
import { FolioService } from '../folio/folio.service';
import { FolioLine, FolioSource } from '../folio/schemas/folio-line.schema';
import { EventsService } from '../notifications/events.service';
import { Room, RoomStatus } from '../rooms/schemas/room.schema';
import {
  CLOSED_REQUEST_STATUSES,
  ServiceRequest,
  ServiceRequestKey,
  ServiceRequestStatus,
} from '../service-requests/schemas/service-request.schema';
import { CheckInDto, CheckOutDto, ShiftRoomDto, StayPaymentDto, StayPaymentKind, UpdateStayDto } from './dto/stay.dto';
import { RoomShift, ShiftKind } from './schemas/room-shift.schema';
import { Stay, StayDocument, StayStatus } from './schemas/stay.schema';
import { StayViewService } from './stay-view.service';

const PAYMENT_TYPE: Record<StayPaymentKind, string> = {
  [StayPaymentKind.ADVANCE]: 'Advance',
  [StayPaymentKind.PART_PAYMENT]: 'Part payment',
  [StayPaymentKind.REFUND]: 'Refund',
};

interface Segment {
  _id?: Types.ObjectId;
  label: string;
  roomId: Types.ObjectId;
  roomNumber: string;
  guests: number;
  rate: Types.Decimal128;
  nights: number;
  folioLineId: Types.ObjectId | null;
}

@Injectable()
export class StaysService {
  constructor(
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(FolioLine.name) private readonly folioLines: Model<FolioLine>,
    @InjectModel(Booking.name) private readonly bookings: Model<Booking>,
    @InjectModel(RoomShift.name) private readonly shifts: Model<RoomShift>,
    @InjectModel(ServiceRequest.name) private readonly requests: Model<ServiceRequest>,
    private readonly tx: TransactionService,
    private readonly ledger: LedgerService,
    private readonly daybook: DaybookService,
    private readonly folio: FolioService,
    private readonly view: StayViewService,
    private readonly audit: AuditService,
    private readonly dates: BusinessDateService,
    private readonly tax: TaxService,
    private readonly events: EventsService,
  ) {}

  async checkIn(dto: CheckInDto, user: Principal) {
    const checkIn = dto.businessDate ?? this.dates.today();
    this.dates.assertAllowed(checkIn, user);
    const { checkOut, nights } = this.stayLength(checkIn, dto.checkOut, dto.nights);
    const guests = dto.guests ?? 1;

    const stayId = await this.tx.run(async ({ session, afterCommit }) => {
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
      // Any rate the app sent is ignored; the room and guest count decide it.
      const rate = toD128(nightlyRate(room, guests));

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
            guests,
            bookingId: oidOrNull(dto.bookingId),
          },
        ],
        { session },
      );
      const segment = await this.writeSegmentLine(
        stay._id,
        { label: `Room ${room.number}`, roomId: room._id, roomNumber: room.number, guests, rate, nights, folioLineId: null },
        session,
      );
      stay.roomCharges = [segment] as any;
      await stay.save({ session });
      if (dto.bookingId) {
        await this.bookings.updateOne({ _id: dto.bookingId }, { $set: { status: BookingStatus.CHECKED_IN } }, { session });
      }

      afterCommit(() => {
        this.events.toHotel('room.status.changed', { roomId: String(room._id), status: room.status });
        this.events.toHotelAndStay('stay.updated', stay._id, { stayId: String(stay._id) });
      });
      return stay._id;
    });
    return { stay: await this.present(stayId) };
  }

  /** Edit a stay, with at most one advance, part payment or refund, and an optional guest-count change. */
  async update(id: Types.ObjectId, dto: UpdateStayDto, user: Principal) {
    if (dto.payment) this.dates.assertAllowed(dto.payment.businessDate, user);
    const effective = dto.businessDate ?? this.dates.today();
    if (dto.guests !== undefined) this.dates.assertAllowed(effective, user);
    const current = await this.stays.findById(id).lean();
    if (!current) throw notFound('Stay');
    if (current.status !== StayStatus.IN_HOUSE) throw conflict('STAY_NOT_IN_HOUSE', 'This stay has already checked out');

    const work = () =>
      this.tx.run(async ({ session, afterCommit }) => {
        const stay = await this.stays.findOne({ _id: id, status: StayStatus.IN_HOUSE }).session(session);
        if (!stay) throw conflict('STAY_NOT_IN_HOUSE', 'This stay has already checked out');
        const room = await this.rooms.findById(stay.roomId).session(session);
        const segments = await this.segmentsOf(stay, session);

        if (dto.guestName !== undefined) stay.guestName = dto.guestName.trim();
        if (dto.phone !== undefined) stay.phone = normalizePhone(dto.phone);
        if (dto.vehicle !== undefined) stay.vehicle = dto.vehicle || null;

        if (dto.guests !== undefined && dto.guests !== (stay.guests ?? 1)) {
          const newRate = toD128(nightlyRate(room!, dto.guests));
          const nightsBefore = this.nightsUpTo(stay, effective);
          const before = { guests: stay.guests ?? 1, rate: stay.rate };
          await this.splitTail(stay._id, segments, nightsBefore, { ...this.last(segments), guests: dto.guests, rate: newRate }, session);
          stay.guests = dto.guests;
          stay.rate = newRate;
          await this.audit.record(
            AuditAction.GUEST_COUNT_CHANGE,
            stay._id,
            userObjectId(user),
            { from: before, to: { guests: dto.guests, rate: newRate }, effective, nightsBefore },
            session,
          );
        }

        if (dto.checkOut !== undefined && dto.checkOut !== stay.checkOut) {
          const { checkOut, nights } = this.stayLength(stay.checkIn, dto.checkOut);
          const tail = this.last(segments);
          const tailNights = tail.nights + (nights - stay.nights);
          if (tailNights < 1) {
            throw badRequest('INVALID_STAY_DATES', 'Check-out is before the nights already moved to another room or rate');
          }
          tail.nights = tailNights;
          await this.writeSegmentLine(stay._id, tail, session);
          stay.checkOut = checkOut;
          stay.nights = nights;
        }
        stay.roomCharges = segments as any;
        await stay.save({ session });

        let entry = null;
        if (dto.payment) entry = await this.postPayment(stay, room!.number, dto.payment, user, session);

        afterCommit(() => {
          this.events.toHotelAndStay('stay.updated', stay._id, { stayId: String(stay._id) });
          this.events.toHotelAndStay('folio.updated', stay._id, { stayId: String(stay._id) });
          if (entry) this.events.toHotel('entry.created', { id: String(entry._id), businessDate: entry.businessDate });
        });
        return { stayId: stay._id, entry };
      });

    const run = !dto.payment
      ? work
      : () =>
          this.ledger.withDuplicateGuard(
            {
              businessDate: dto.payment!.businessDate,
              roomId: current.roomId,
              type: PAYMENT_TYPE[dto.payment!.kind],
              amount: dto.payment!.amount,
              guestName: dto.guestName ?? current.guestName,
            },
            work,
          );
    const { stayId, entry } = await run();
    return { stay: await this.present(stayId), entry };
  }

  /** Move an in-house guest to another room, answering their ROOM_SHIFT request. */
  async shift(id: Types.ObjectId, dto: ShiftRoomDto, user: Principal) {
    this.dates.assertAllowed(dto.businessDate, user);
    const stayId = await this.tx.run(async ({ session, afterCommit }) => {
      const request = await this.requests.findById(dto.requestId).session(session);
      if (!request || request.key !== ServiceRequestKey.ROOM_SHIFT) {
        throw badRequest('INVALID_SHIFT_REQUEST', 'A room shift needs the guest’s room shift request');
      }
      if (String(request.stayId) !== String(id)) {
        throw badRequest('INVALID_SHIFT_REQUEST', 'That request belongs to another stay');
      }
      if (CLOSED_REQUEST_STATUSES.includes(request.status)) {
        throw conflict('SHIFT_REQUEST_CLOSED', `This request is already ${request.status}`);
      }

      const stay = await this.stays.findOne({ _id: id, status: StayStatus.IN_HOUSE }).session(session);
      if (!stay) {
        if (!(await this.stays.exists({ _id: id }).session(session))) throw notFound('Stay');
        throw conflict('STAY_NOT_IN_HOUSE', 'This stay has already checked out');
      }
      // Checked before any write, so a bad date leaves the rooms untouched.
      const nightsBefore = this.nightsUpTo(stay, dto.businessDate);
      const nightsLeft = stay.nights - nightsBefore;

      // Claim the target room: only a VACANT room can be taken, and only once.
      const target = await this.rooms.findOneAndUpdate(
        { _id: dto.toRoomId, status: RoomStatus.VACANT },
        { $set: { status: RoomStatus.OCCUPIED } },
        { new: true, session },
      );
      if (!target) {
        if (!(await this.rooms.exists({ _id: dto.toRoomId }).session(session))) throw notFound('Room');
        throw conflict('ROOM_NOT_VACANT', 'The new room is not vacant');
      }
      const from = await this.rooms.findByIdAndUpdate(stay.roomId, { $set: { status: RoomStatus.DIRTY } }, { new: true, session });

      const segments = await this.segmentsOf(stay, session);
      const oldRate = this.last(segments).rate;
      const newRate = toD128(nightlyRate(target, dto.guests));
      const diff = dec(newRate).minus(dec(oldRate));
      const adjustment = toD128(diff.times(nightsLeft));
      const kind = diff.gt(0) ? ShiftKind.UPGRADE : diff.lt(0) ? ShiftKind.DOWNGRADE : ShiftKind.SAME;

      await this.splitTail(
        stay._id,
        segments,
        nightsBefore,
        { label: `Room ${target.number}`, roomId: target._id, roomNumber: target.number, guests: dto.guests, rate: newRate, nights: 0, folioLineId: null },
        session,
      );
      const before = { roomId: stay.roomId, guests: stay.guests ?? 1, rate: stay.rate };
      stay.roomId = target._id;
      stay.guests = dto.guests;
      stay.rate = newRate;
      stay.roomCharges = segments as any;
      await stay.save({ session });

      const [record] = await this.shifts.create(
        [
          {
            stayId: stay._id,
            requestId: request._id,
            fromRoomId: before.roomId,
            toRoomId: target._id,
            fromRate: oldRate,
            toRate: newRate,
            kind,
            businessDate: dto.businessDate,
            time: dto.time,
            nightsBefore,
            nightsLeft,
            adjustment,
            reason: dto.reason ?? request.note ?? '',
            createdByUserId: userObjectId(user),
          },
        ],
        { session },
      );
      request.status = ServiceRequestStatus.DONE;
      request.handledByUserId = userObjectId(user);
      request.remark = dto.reason ?? `Moved to room ${target.number}`;
      await request.save({ session });
      await this.audit.record(
        AuditAction.ROOM_SHIFT,
        stay._id,
        userObjectId(user),
        { shiftId: record._id, from: before, to: { roomId: target._id, guests: dto.guests, rate: newRate }, nightsBefore, nightsLeft, adjustment, kind },
        session,
      );

      afterCommit(() => {
        this.events.toHotel('room.status.changed', { roomId: String(from?._id), status: RoomStatus.DIRTY });
        this.events.toHotel('room.status.changed', { roomId: String(target._id), status: RoomStatus.OCCUPIED });
        this.events.toHotelAndStay('stay.updated', stay._id, { stayId: String(stay._id) });
        this.events.toHotelAndStay('folio.updated', stay._id, { stayId: String(stay._id) });
        this.events.toHotelAndStay('service-request.updated', stay._id, {
          id: String(request._id),
          key: request.key,
          status: request.status,
        });
      });
      return stay._id;
    });
    return this.present(stayId);
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
      const room = await this.rooms.findByIdAndUpdate(stay.roomId, { $set: { status: RoomStatus.DIRTY } }, { new: true, session });
      // A shift can't happen after check-out, so open shift requests lapse.
      await this.requests.updateMany(
        { stayId: stay._id, key: ServiceRequestKey.ROOM_SHIFT, status: { $nin: CLOSED_REQUEST_STATUSES } },
        { $set: { status: ServiceRequestStatus.EXPIRED, remark: 'Guest checked out' } },
        { session },
      );
      afterCommit(() => {
        this.events.toHotel('room.status.changed', { roomId: String(stay.roomId), status: room?.status });
        this.events.toHotelAndStay('stay.updated', stay._id, { stayId: String(stay._id), status: stay.status });
        this.events.endStay(stay._id);
      });
      return stay;
    });
    const bill = await this.folio.summary(result._id);
    return { stay: await this.present(result._id), folioBalance: bill.balance, bill: bill.breakdown };
  }

  async inHouse() {
    const stays = await this.stays.find({ status: StayStatus.IN_HOUSE }).sort({ checkIn: 1 }).lean();
    const rooms = await this.rooms.find({ _id: { $in: stays.map((s) => s.roomId) } }).lean();
    const balances = await this.folio.balances(stays.map((s) => s._id));
    const roomById = new Map(rooms.map((r) => [String(r._id), r]));
    const decorated = await this.view.decorate(stays);
    return decorated.map((stay) => ({
      ...stay,
      balance: balances.get(String(stay._id)) ?? toD128('0'),
      room: roomById.get(String(stay.roomId)) ?? null,
    }));
  }

  private async present(id: Types.ObjectId) {
    const stay = await this.stays.findById(id).lean();
    const [view] = await this.view.decorate([stay!]);
    return view;
  }

  private async postPayment(stay: StayDocument, roomNumber: string, p: StayPaymentDto, user: Principal, session: ClientSession) {
    const type = PAYMENT_TYPE[p.kind];
    const isRefund = p.kind === StayPaymentKind.REFUND;
    await this.daybook.touchOpenDay(p.businessDate, user, session);
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
  }

  /** The stay's segments; a stay from before segments gets one built from its TARIFF line. */
  private async segmentsOf(stay: StayDocument, session: ClientSession): Promise<Segment[]> {
    if (stay.roomCharges?.length) {
      return stay.roomCharges.map((s: any) => (typeof s.toObject === 'function' ? s.toObject() : { ...s }));
    }
    const room = await this.rooms.findById(stay.roomId).select('number').session(session).lean();
    const line = await this.folioLines.findOne({ stayId: stay._id, source: FolioSource.TARIFF }).session(session).lean();
    return [
      {
        label: `Room ${room?.number ?? ''}`,
        roomId: stay.roomId,
        roomNumber: room?.number ?? '',
        guests: stay.guests ?? 1,
        rate: stay.rate,
        nights: stay.nights,
        folioLineId: line?._id ?? null,
      },
    ];
  }

  private last(segments: Segment[]) {
    return segments[segments.length - 1];
  }

  /** Nights from check-in up to `date`; at least one night must be left after it. */
  private nightsUpTo(stay: StayDocument, date: string) {
    const n = this.dates.daysBetween(stay.checkIn, date);
    if (n < 0) throw badRequest('INVALID_DATE', 'That date is before check-in');
    if (n >= stay.nights) throw badRequest('NO_NIGHTS_LEFT', 'No nights are left on this stay from that date');
    return n;
  }

  /**
   * Ends the current segment after `nightsBefore` nights of the whole stay and
   * starts `next` for the rest. Earlier nights keep their room and rate.
   */
  private async splitTail(stayId: Types.ObjectId, segments: Segment[], nightsBefore: number, next: Segment, session: ClientSession) {
    const tail = this.last(segments);
    const tailStart = segments.slice(0, -1).reduce((n, s) => n + s.nights, 0);
    const kept = nightsBefore - tailStart;
    if (kept < 0) throw badRequest('INVALID_DATE', 'That date is before the current room or rate started');
    const opened: Segment = { ...next, folioLineId: null, nights: tail.nights - kept };
    delete opened._id;
    if (kept === 0) {
      // No night was spent on the current segment: replace it outright.
      if (tail.folioLineId) {
        await this.folioLines.updateOne({ _id: tail.folioLineId }, { $set: { deletedAt: new Date() } }, { session });
      }
      segments.pop();
    } else {
      tail.nights = kept;
      await this.writeSegmentLine(stayId, tail, session);
    }
    segments.push(await this.writeSegmentLine(stayId, opened, session));
  }

  /** Creates or rewrites the segment's TARIFF folio line: rate × nights + 12% GST. */
  private async writeSegmentLine(stayId: Types.ObjectId, seg: Segment, session: ClientSession): Promise<Segment> {
    const line = {
      head: `${seg.label} (${seg.guests} guest${seg.guests === 1 ? '' : 's'}): ${seg.nights} night${seg.nights === 1 ? '' : 's'} + 12% GST`,
      amount: toD128(this.tax.room(dec(seg.rate).times(seg.nights)).total),
    };
    if (seg.folioLineId) {
      await this.folioLines.updateOne({ _id: seg.folioLineId }, { $set: line }, { session });
      return seg;
    }
    const [created] = await this.folioLines.create([{ stayId, source: FolioSource.TARIFF, ...line }], { session });
    seg.folioLineId = created._id;
    return seg;
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
