import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import Decimal from 'decimal.js';
import { ClientSession, Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { Booking, BookingStatus } from '../bookings/schemas/booking.schema';
import { DebitCredit, PaymentMode } from '../common/enums';
import { badRequest, conflict, notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { oidOrNull } from '../common/pipes/parse-object-id.pipe';
import { BusinessDateService } from '../common/services/business-date.service';
import { GstService, StayGstMode } from '../common/services/gst.service';
import { TaxService } from '../common/services/tax.service';
import { dec, toD128 } from '../common/utils/money';
import { normalizePhone } from '../common/utils/phone';
import { assertFits, nightlyRate, occupancyRate, roomCapacity } from '../config/pricing';
import { DaybookService } from '../daybook/daybook.service';
import { TransactionService } from '../database/transaction.service';
import { LedgerService } from '../entries/ledger.service';
import { DayRegisterEntry, EntrySource } from '../entries/schemas/day-register-entry.schema';
import { Settlement } from './schemas/settlement.schema';
import { settlementRow } from './settlement-row';
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
import { AddGuestDto, AdjustmentKind, CheckInDto, CheckoutAdjustmentDto, CheckOutDto, ShiftRoomDto, StayPaymentDto, StayPaymentKind, UpdateStayDto } from './dto/stay.dto';
import { RoomShift, ShiftKind } from './schemas/room-shift.schema';
import { StayGuest } from './schemas/stay-guest.schema';
import { CustomersService } from '../customers/customers.service';
import { CustomerCreditService } from '../customers/customer-credit.service';
import { Stay, StayDocument, StayStatus } from './schemas/stay.schema';
import { StayViewService } from './stay-view.service';
import { StayBillService } from './stay-bill.service';
import { CounterService } from '../database/counter.service';

/** Payments through "Edit stay" this soon before check-out count as part of it. */
const SETTLEMENT_WINDOW_MS = 2 * 60_000;

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
  gstPct?: number | null;
}

type StayGstRef = { _id: Types.ObjectId; gst?: StayGstMode | null };

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
    @InjectModel(StayGuest.name) private readonly stayGuests: Model<StayGuest>,
    private readonly customers: CustomersService,
    private readonly gst: GstService,
    private readonly counters: CounterService,
    private readonly bills: StayBillService,
    private readonly creditLedger: CustomerCreditService,
    @InjectModel(Settlement.name) private readonly settlements: Model<Settlement>,
    @InjectModel(DayRegisterEntry.name) private readonly entries: Model<DayRegisterEntry>,
  ) {}

  async checkIn(dto: CheckInDto, user: Principal) {
    const checkIn = dto.businessDate ?? this.dates.today();
    this.dates.assertAllowed(checkIn, user);
    const { checkOut, nights } = this.stayLength(checkIn, dto.checkOut, dto.nights);

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
      // Any rate the app sent is ignored. A booked room is charged what was booked
      // (later tariff changes don't apply); a walk-in is charged the room's own prices.
      const { guests, rate, lineId } = await this.checkInRate(room, dto, session);
      const customer = await this.customers.forVisit({ customerId: dto.customerId, name: dto.guestName, phone: dto.phone }, session);

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
            customerId: customer._id,
            gst: this.gst.newStayMode(),
          },
        ],
        { session },
      );
      const segment = await this.writeSegmentLine(
        stay,
        { label: `Room ${room.number}`, roomId: room._id, roomNumber: room.number, guests, rate, nights, folioLineId: null },
        session,
      );
      stay.roomCharges = [segment] as any;
      // Every stay belongs to a booking; a walk-in gets its own one-room booking.
      if (!stay.bookingId) {
        const booking = await this.customers.bookingForStay(stay, room.roomTypeId, session);
        stay.bookingId = booking._id;
      }
      await stay.save({ session });
      let advance = null;
      if (dto.advance && dec(dto.advance.amount).gt(0)) {
        const businessDate = await this.daybook.requireOpenDay(session);
        advance = await this.ledger.post(
          {
            businessDate,
            time: dto.advance.time,
            roomId: room._id,
            stayId: stay._id,
            guestName: stay.guestName,
            phone: stay.phone,
            vehicle: stay.vehicle,
            type: 'Check-in',
            mode: dto.advance.mode,
            dc: DebitCredit.CREDIT,
            amount: dto.advance.amount,
            narration: dto.advance.narration ?? `Advance at check-in, room ${room.number}`,
            source: EntrySource.CHECKIN,
            createdByUserId: userObjectId(user),
            folio: { head: 'Advance at check-in', source: FolioSource.PAYMENT },
          },
          session,
        );
      }
      if (dto.bookingId) {
        await this.bookings.updateOne({ _id: dto.bookingId }, { $set: { status: BookingStatus.CHECKED_IN } }, { session });
        if (lineId) {
          // Claims the line; a check-in racing for the same line conflicts and is retried with the next one.
          const claimed = await this.bookings.updateOne(
            { _id: dto.bookingId, roomLines: { $elemMatch: { _id: lineId, stayId: null } } },
            { $set: { 'roomLines.$.stayId': stay._id } },
            { session },
          );
          if (!claimed.modifiedCount) throw conflict('BOOKING_LINE_TAKEN', 'That booked room was just checked in; try again');
        }
      }

      afterCommit(() => {
        this.events.toHotel('room.status.changed', { roomId: String(room._id), status: room.status });
        this.events.toHotelAndStay('stay.updated', stay._id, { stayId: String(stay._id) });
        if (advance) this.events.toHotel('entry.created', { id: String(advance._id), businessDate: advance.businessDate });
      });
      return { stayId: stay._id, customerId: customer._id };
    });
    return { stay: await this.present(stayId.stayId), customer: { id: stayId.customerId } };
  }

  private async checkInRate(room: Room & { _id: Types.ObjectId }, dto: CheckInDto, session: ClientSession) {
    if (dto.bookingId) {
      const booking = await this.bookings.findById(dto.bookingId).session(session).lean();
      if (!booking) throw notFound('Booking');
      // The booking's next free line, preferring one of this room's type.
      const free = (booking.roomLines ?? []).filter((l) => !l.stayId);
      const line = free.find((l) => String(l.roomTypeId) === String(room.roomTypeId)) ?? free[0] ?? null;
      const guests = dto.guests ?? line?.guests ?? 1;
      assertFits(room, guests);
      const lineId = line?._id ?? null;
      if (line && guests === line.guests) return { guests, rate: line.rate, lineId };
      const saved = line?.rateCard ?? booking.rateCard;
      if (saved) {
        const card = { singleRate: dec(saved.singleRate), doubleRate: dec(saved.doubleRate), additionalGuestRate: dec(saved.additionalGuestRate) };
        return { guests, rate: toD128(occupancyRate(card, guests)), lineId };
      }
      return { guests, rate: toD128(nightlyRate(room, guests)), lineId };
    }
    const guests = dto.guests ?? 1;
    return { guests, rate: toD128(nightlyRate(room, guests)), lineId: null };
  }

  /** Edit a stay, with at most one advance, part payment or refund, and an optional guest-count change. */
  async update(id: Types.ObjectId, dto: UpdateStayDto, user: Principal) {
    const openDate = await this.daybook.openDate();
    const effective = dto.businessDate ?? openDate ?? this.dates.today();
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
          await this.splitTail(stay, segments, nightsBefore, { ...this.last(segments), guests: dto.guests, rate: newRate }, session);
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
          await this.writeSegmentLine(stay, tail, session);
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
              businessDate: openDate ?? '',
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

  /**
   * Adds a guest to an in-house stay. The rate for the new total applies from
   * `businessDate` on: the current segment ends there and a new one starts,
   * so the folio changes by (new − old rate) × nights left, plus GST.
   * No cash entry is made.
   */
  async addGuest(id: Types.ObjectId, dto: AddGuestDto, user: Principal) {
    const date = dto.businessDate ?? (await this.daybook.openDate()) ?? this.dates.today();
    const result = await this.tx.run(async ({ session, afterCommit }) => {
      const stay = await this.stays.findOne({ _id: id, status: StayStatus.IN_HOUSE }).session(session);
      if (!stay) {
        if (!(await this.stays.exists({ _id: id }).session(session))) throw notFound('Stay');
        throw conflict('STAY_NOT_IN_HOUSE', 'This stay has already checked out');
      }
      const current = stay.guests ?? 1;
      const room = await this.rooms.findById(stay.roomId).session(session);
      const capacity = roomCapacity(room!);
      if (current >= capacity || dto.guests > capacity) {
        throw conflict('GUEST_LIMIT', `Room ${room!.number} sleeps at most ${capacity} guests`);
      }
      if (dto.guests <= current) {
        throw badRequest('INVALID_GUEST_COUNT', `guests is the new total and must be more than ${current}`);
      }
      const stayed = this.dates.daysBetween(stay.checkIn, date);
      if (stayed < 0 || date > stay.checkOut) throw badRequest('INVALID_DATE', 'The date must fall within the stay');
      const nightsLeft = stay.nights - stayed;

      const segments = await this.segmentsOf(stay, session);
      const oldRate = this.last(segments).rate;
      const newRate = toD128(nightlyRate(room!, dto.guests));
      const adjustment = dec(newRate).minus(dec(oldRate)).times(nightsLeft);
      if (nightsLeft > 0) {
        await this.splitTail(stay, segments, stayed, { ...this.last(segments), guests: dto.guests, rate: newRate }, session);
      }
      stay.guests = dto.guests;
      stay.rate = newRate;
      stay.roomCharges = segments as any;
      await stay.save({ session });

      const customer = dto.phone?.trim()
        ? await this.customers.forVisit({ name: dto.name, phone: dto.phone }, session)
        : null;
      const [guest] = await this.stayGuests.create(
        [
          {
            stayId: stay._id,
            name: dto.name?.trim() ?? '',
            phone: normalizePhone(dto.phone),
            customerId: customer?._id ?? null,
            addedAt: new Date(),
            businessDate: date,
            guestsAfter: dto.guests,
            fromRate: oldRate,
            toRate: newRate,
            nightsLeft,
            adjustment: toD128(adjustment),
            addedByUserId: userObjectId(user),
          },
        ],
        { session },
      );
      await this.audit.record(
        AuditAction.GUEST_ADDED,
        stay._id,
        userObjectId(user),
        { guestId: guest._id, customerId: customer?._id ?? null, from: { guests: current, rate: oldRate }, to: { guests: dto.guests, rate: newRate }, date, time: dto.time ?? null, nightsLeft, adjustment: toD128(adjustment) },
        session,
      );
      afterCommit(() => {
        this.events.toHotelAndStay('stay.updated', stay._id, { stayId: String(stay._id) });
        this.events.toHotelAndStay('folio.updated', stay._id, { stayId: String(stay._id) });
      });
      return { stayId: stay._id, guest: { id: guest._id, customerId: customer?._id ?? null }, adjustment };
    });
    return { stay: await this.present(result.stayId), guest: result.guest, adjustment: toD128(result.adjustment) };
  }

  /** Move an in-house guest to another room, answering their ROOM_SHIFT request. */
  async shift(id: Types.ObjectId, dto: ShiftRoomDto, user: Principal) {
    this.dates.assertAllowed(dto.businessDate, user);
    const stayId = await this.tx.run(async ({ session, afterCommit }) => {
      // With a requestId the shift answers the guest's request; without one the manager started it.
      const request = dto.requestId ? await this.requests.findById(dto.requestId).session(session) : null;
      if (dto.requestId) {
        if (!request || request.key !== ServiceRequestKey.ROOM_SHIFT) {
          throw badRequest('INVALID_SHIFT_REQUEST', 'requestId is not a room shift request');
        }
        if (String(request.stayId) !== String(id)) {
          throw badRequest('INVALID_SHIFT_REQUEST', 'That request belongs to another stay');
        }
        if (CLOSED_REQUEST_STATUSES.includes(request.status)) {
          throw conflict('SHIFT_REQUEST_CLOSED', `This request is already ${request.status}`);
        }
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
        stay,
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
            requestId: request?._id ?? null,
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
            reason: dto.reason ?? request?.note ?? '',
            createdByUserId: userObjectId(user),
          },
        ],
        { session },
      );
      if (request) {
        request.status = ServiceRequestStatus.DONE;
        request.handledByUserId = userObjectId(user);
        request.remark = dto.reason ?? `Moved to room ${target.number}`;
        await request.save({ session });
      }
      await this.audit.record(
        AuditAction.ROOM_SHIFT,
        stay._id,
        userObjectId(user),
        { shiftId: record._id, requestId: request?._id ?? null, managerInitiated: !request, from: before, to: { roomId: target._id, guests: dto.guests, rate: newRate }, nightsBefore, nightsLeft, adjustment, kind },
        session,
      );

      afterCommit(() => {
        this.events.toHotel('room.status.changed', { roomId: String(from?._id), status: RoomStatus.DIRTY });
        this.events.toHotel('room.status.changed', { roomId: String(target._id), status: RoomStatus.OCCUPIED });
        this.events.toHotelAndStay('stay.updated', stay._id, { stayId: String(stay._id) });
        this.events.toHotelAndStay('folio.updated', stay._id, { stayId: String(stay._id) });
        if (request) {
          this.events.toHotelAndStay('service-request.updated', stay._id, {
            id: String(request._id),
            key: request.key,
            status: request.status,
          });
        }
      });
      return stay._id;
    });
    return this.present(stayId);
  }

  /**
   * Check-out, in one transaction: adjustments to the folio, one ledger row
   * per payment (for mode totals and cash reconciliation), the stay closed,
   * and one Settlement owning those rows, which is what the register shows.
   * Payments taken through PATCH /stays/:id in the two minutes before belong
   * to the check-out too. An Idempotency-Key makes a retry return the first result.
   */
  async checkOut(id: Types.ObjectId, dto: CheckOutDto, user: Principal, idempotencyKey?: string) {
    if (dto.payment && dto.payments) throw badRequest('PAYMENT_CONFLICT', 'Send payment or payments, not both');
    const key = idempotencyKey?.trim() || null;
    const replay = async () => {
      if (!key) return null;
      const done = await this.settlements.findOne({ idempotencyKey: key }).lean();
      if (!done) return null;
      if (String(done.stayId) !== String(id)) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for another check-out');
      return this.checkoutResult(id);
    };
    const earlier = await replay();
    if (earlier) return earlier;
    try {
      await this.tx.run((ctx) => this.checkOutTx(id, dto, user, key, ctx));
    } catch (err: any) {
      // A double tap that lost the race: answer with the check-out that won.
      const again = key && (err?.code === 11000 || err?.response?.code === 'STAY_NOT_IN_HOUSE') ? await replay() : null;
      if (again) return again;
      throw err;
    }
    return this.checkoutResult(id);
  }

  private async checkOutTx(
    id: Types.ObjectId,
    dto: CheckOutDto,
    user: Principal,
    idempotencyKey: string | null,
    { session, afterCommit }: { session: ClientSession; afterCommit: (fn: () => void) => void },
  ) {
    const businessDate = await this.daybook.requireOpenDay(session);
    const rows = dto.payments?.length ? dto.payments : dto.payment && dec(dto.payment.amount).gt(0) ? [dto.payment] : [];
    const time = dto.time ?? rows[0]?.time ?? this.dates.nowTime();
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
    // The booking is CHECKED_OUT once none of its rooms is still in house.
    if (stay.bookingId && !(await this.stays.exists({ bookingId: stay.bookingId, status: StayStatus.IN_HOUSE }).session(session))) {
      await this.bookings.updateOne({ _id: stay.bookingId }, { $set: { status: BookingStatus.CHECKED_OUT } }, { session });
    }
    // A shift can't happen after check-out, so open shift requests lapse.
    await this.requests.updateMany(
      { stayId: stay._id, key: ServiceRequestKey.ROOM_SHIFT, status: { $nin: CLOSED_REQUEST_STATUSES } },
      { $set: { status: ServiceRequestStatus.EXPIRED, remark: 'Guest checked out' } },
      { session },
    );

    // 1. Adjustments change the folio before anything is settled.
    for (const adj of dto.adjustments ?? []) await this.applyAdjustment(stay, adj, businessDate, user, session);

    const [charges] = await this.folioLines.aggregate<{ total: Types.Decimal128 }>([
      { $match: { stayId: stay._id, deletedAt: null, source: { $nin: [FolioSource.PAYMENT, FolioSource.REFUND, FolioSource.CREDIT] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]).session(session);
    const billTotal = dec(charges?.total);
    await this.customers.addSpent(stay.customerId, billTotal.toFixed(2), session);

    // Payments posted just before through "Edit stay" are part of this check-out.
    const attached = await this.entries
      .find({
        stayId: stay._id,
        businessDate,
        source: EntrySource.STAY_PAYMENT,
        settlementId: null,
        createdAt: { $gte: new Date(Date.now() - SETTLEMENT_WINDOW_MS) },
      })
      .session(session)
      .lean();

    // 2. Each payment is its own ledger row, so mode totals and expected cash stay exact.
    const owed = dec((await this.folio.balances([stay._id], session)).get(String(stay._id)));
    const received = rows.reduce((t, r) => t.plus(dec(r.amount)), dec(0));
    const onCredit = dec(dto.creditAmount ?? '0');
    if (onCredit.gt(0)) {
      if (!stay.customerId) throw badRequest('NO_CUSTOMER', 'This stay has no customer to put on credit');
      if (onCredit.gt(owed.minus(received))) {
        throw badRequest('CREDIT_TOO_HIGH', `Only ${Decimal.max(0, owed.minus(received)).toFixed(2)} is left unpaid`);
      }
      // Settles the folio like a payment, and the customer owes it instead. No money moves.
      await this.creditLedger.charge(
        stay.customerId,
        { amount: onCredit.toFixed(2), narration: `Unpaid at check-out, room ${room?.number}`, businessDate, time, stayId: stay._id },
        user,
        session,
      );
      await this.folioLines.create([{ stayId: stay._id, head: 'Moved to customer credit', amount: toD128(onCredit.negated()), source: FolioSource.CREDIT }], { session });
    }
    const posted: Awaited<ReturnType<LedgerService['post']>>[] = [];
    for (const row of rows) {
      posted.push(
        await this.ledger.post(
          {
            businessDate,
            time: row.time ?? time,
            roomId: stay.roomId,
            stayId: stay._id,
            guestName: stay.guestName,
            phone: stay.phone,
            vehicle: stay.vehicle,
            type: 'Check-out',
            mode: row.mode,
            dc: DebitCredit.CREDIT,
            amount: dec(row.amount).toFixed(2),
            narration: row.narration ?? dto.narration ?? '',
            source: EntrySource.CHECKOUT,
            // Rows of one check-out may repeat a mode and amount on purpose.
            dupCheck: false,
            createdByUserId: userObjectId(user),
            folio: { head: `Payment at check-out (${row.mode})`, source: FolioSource.PAYMENT },
          },
          session,
        ),
      );
    }

    // 3. Unpaid balance, and 4. the one settlement that owns the rows.
    const shortfall = Decimal.max(0, owed.minus(received).minus(onCredit));
    const owned = [...attached, ...posted];
    const [settlement] = await this.settlements.create(
      [
        {
          stayId: stay._id,
          roomId: stay.roomId,
          customerId: stay.customerId ?? null,
          businessDate,
          time,
          guestName: stay.guestName,
          phone: stay.phone,
          vehicle: stay.vehicle,
          narration: dto.narration ?? rows.find((r) => r.narration)?.narration ?? attached.find((e) => e.narration)?.narration ?? '',
          billTotal: toD128(billTotal),
          amount: toD128(owned.reduce((t, e) => t.plus(dec(e.amount)), dec(0))),
          payments: owned.map((e) => ({ entryId: e._id, mode: e.mode, amount: e.amount })),
          creditAmount: onCredit.gt(0) ? toD128(onCredit) : null,
          shortfall: shortfall.gt(0) ? toD128(shortfall) : null,
          idempotencyKey,
          createdByUserId: userObjectId(user),
        },
      ],
      { session },
    );
    if (owned.length) {
      await this.entries.updateMany({ _id: { $in: owned.map((e) => e._id) } }, { $set: { settlementId: settlement._id } }, { session });
    }

    // The bill number is given once, here, and never reused: a per-financial-year counter.
    const fy = this.gst.financialYear(businessDate);
    stay.billNo = StayBillService.format(this.gst.settings.billPrefix, fy, await this.counters.next(`bill:${fy}`, session));
    stay.billDate = businessDate;
    await stay.save({ session });
    await this.audit.record(
      AuditAction.CHECKOUT,
      stay._id,
      userObjectId(user),
      { settlementId: settlement._id, billTotal: settlement.billTotal, amount: settlement.amount, shortfall: settlement.shortfall, creditAmount: settlement.creditAmount, adjustments: dto.adjustments ?? [] },
      session,
      businessDate,
    );
    afterCommit(() => {
      this.events.toHotel('room.status.changed', { roomId: String(stay.roomId), status: room?.status });
      this.events.toHotelAndStay('stay.updated', stay._id, { stayId: String(stay._id), status: stay.status });
      this.events.toHotel('entry.created', { id: String(settlement._id), businessDate });
      this.events.endStay(stay._id);
    });
  }

  /** A discount or complimentary item lowers a section; a half day raises the stay. GST follows the section's rate. */
  private async applyAdjustment(stay: StayDocument, adj: CheckoutAdjustmentDto, businessDate: string, user: Principal, session: ClientSession) {
    const adds = adj.kind === AdjustmentKind.HALF_DAY;
    if (adds && adj.section !== 'STAY') throw badRequest('INVALID_ADJUSTMENT', 'A half day is charged on the stay');
    const s = this.gst.settings;
    const pct = adj.section === 'STAY' ? this.gst.roomPct(stay.rate, stay.gst) : adj.section === 'FOOD' ? s.foodPct : s.otherPct;
    if (!adds) {
      const sources = { STAY: FolioSource.TARIFF, FOOD: FolioSource.FOOD, OTHER: FolioSource.OTHER }[adj.section];
      const lines = await this.folioLines.find({ stayId: stay._id, $or: [{ source: sources }, { source: FolioSource.ADJUSTMENT, section: adj.section }] }).session(session).lean();
      const sectionTotal = lines.reduce((t, l) => t.plus(dec(l.amount)), dec(0));
      if (dec(adj.amount).gt(sectionTotal)) {
        throw badRequest('ADJUSTMENT_TOO_HIGH', `The ${adj.section.toLowerCase()} charges are only ${sectionTotal.toFixed(2)}`);
      }
    }
    const b = this.gst.fromTotal(adj.amount, pct);
    const sign = (d: Decimal) => toD128(adds ? d : d.negated());
    const label = { DISCOUNT: 'Discount', HALF_DAY: 'Half day', COMPLIMENTARY: 'Complimentary' }[adj.kind];
    const [line] = await this.folioLines.create(
      [{ stayId: stay._id, source: FolioSource.ADJUSTMENT, section: adj.section, head: `${label}: ${adj.reason.trim()}`, amount: sign(b.total), gstPct: pct, taxable: sign(b.taxable), cgst: sign(b.cgst), sgst: sign(b.sgst) }],
      { session },
    );
    await this.audit.record(AuditAction.STAY_ADJUSTMENT, stay._id, userObjectId(user), { folioLineId: line._id, ...adj }, session, businessDate);
  }

  /** The check-out as the app reads it, also used to answer a retried request. */
  private async checkoutResult(stayId: Types.ObjectId) {
    const settlement = await this.settlements.findOne({ stayId }).lean();
    const ledgerRows = await this.entries.find({ settlementId: settlement?._id ?? null }).sort({ createdAt: 1 }).lean();
    const bill = await this.folio.summary(stayId);
    const room = settlement ? await this.rooms.findById(settlement.roomId).select('number').lean() : null;
    return {
      stay: await this.present(stayId),
      settlement: settlement ? settlementRow(settlement, room?.number ?? null) : null,
      entry: ledgerRows[ledgerRows.length - 1] ?? null,
      entries: ledgerRows,
      shortfall: settlement?.shortfall ?? toD128('0'),
      folioBalance: bill.balance,
      bill: bill.breakdown,
      finalBill: await this.bills.build(stayId),
    };
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
    // Any businessDate the app sent is ignored.
    const businessDate = await this.daybook.requireOpenDay(session);
    const key = { businessDate, roomId: stay.roomId, type, amount: p.amount, guestName: stay.guestName };
    const duplicate = await this.ledger.findDuplicate(key, session);
    if (duplicate) throw this.ledger.duplicateError(duplicate._id);
    return this.ledger.post(
      {
        businessDate,
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
        source: isRefund ? EntrySource.REFUND : EntrySource.STAY_PAYMENT,
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
  private async splitTail(stay: StayGstRef, segments: Segment[], nightsBefore: number, next: Segment, session: ClientSession) {
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
      await this.writeSegmentLine(stay, tail, session);
    }
    segments.push(await this.writeSegmentLine(stay, opened, session));
  }

  /**
   * Creates or rewrites the segment's TARIFF folio line with its GST breakup.
   * The stay's own GST mode applies, so settings changed later don't touch it;
   * older stays (no mode) keep 12% on top.
   */
  private async writeSegmentLine(stay: StayGstRef, seg: Segment, session: ClientSession): Promise<Segment> {
    const base = dec(seg.rate).times(seg.nights);
    const pct = this.gst.roomPct(seg.rate, stay.gst);
    const b = stay.gst ? this.gst.charge(base, pct, stay.gst.inclusive) : this.tax.room(base);
    const nights = `${seg.nights} night${seg.nights === 1 ? '' : 's'}`;
    const line = {
      head: `${seg.label} (${seg.guests} guest${seg.guests === 1 ? '' : 's'}): ${nights} ${stay.gst?.inclusive ? `incl. ${pct}% GST` : `+ ${pct}% GST`}`,
      amount: toD128(b.total),
      gstPct: pct,
      taxable: toD128(b.taxable),
      cgst: toD128(b.cgst),
      sgst: toD128(b.sgst),
    };
    seg.gstPct = pct;
    if (seg.folioLineId) {
      await this.folioLines.updateOne({ _id: seg.folioLineId }, { $set: line }, { session });
      return seg;
    }
    const [created] = await this.folioLines.create([{ stayId: stay._id, source: FolioSource.TARIFF, ...line }], { session });
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
