import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { GuestScopeService } from '../auth/guest-scope.service';
import { BookingsService } from '../bookings/bookings.service';
import { GuestBookingDto } from '../bookings/dto/booking.dto';
import { Booking, BookingStatus } from '../bookings/schemas/booking.schema';
import { badRequest, conflict } from '../common/errors';
import { Principal } from '../common/interfaces/principal';
import { BusinessDateService } from '../common/services/business-date.service';
import { dec, toD128 } from '../common/utils/money';
import { GuestFeedbackDto } from '../feedback/dto/feedback.dto';
import { Feedback } from '../feedback/schemas/feedback.schema';
import { FolioService } from '../folio/folio.service';
import { FolioLine, FolioSource } from '../folio/schemas/folio-line.schema';
import { GuestOrderDto } from '../kots/dto/kot.dto';
import { KotsService } from '../kots/kots.service';
import { Kot, KotSource } from '../kots/schemas/kot.schema';
import { RoomType } from '../room-types/schemas/room-type.schema';
import { Room } from '../rooms/schemas/room.schema';
import { GuestCheckoutRequestDto, GuestServiceRequestDto } from '../service-requests/dto/service-request.dto';
import {
  CLOSED_REQUEST_STATUSES,
  ServiceRequest,
  ServiceRequestKey,
  ServiceRequestStatus,
} from '../service-requests/schemas/service-request.schema';
import { ServiceRequestsService } from '../service-requests/service-requests.service';
import { Stay, StayStatus } from '../stays/schemas/stay.schema';

/** Booking statuses as the guest app knows them. */
const APP_STATUS: Record<BookingStatus, string> = {
  [BookingStatus.REQUESTED]: 'REQUESTED',
  [BookingStatus.CONFIRMED]: 'CONFIRMED',
  [BookingStatus.ARRIVING]: 'CONFIRMED',
  [BookingStatus.CHECKED_IN]: 'CHECKED_IN',
  [BookingStatus.CHECKED_OUT]: 'CHECKED_OUT',
  [BookingStatus.CANCELLED]: 'CANCELLED',
};
const stayStatus = (s: StayStatus) => (s === StayStatus.IN_HOUSE ? 'CHECKED_IN' : 'CHECKED_OUT');

/**
 * The guest app's data, for one customer. Every query starts from the customer
 * in the token (GuestScopeService); ids from the app are checked for ownership.
 */
@Injectable()
export class GuestService {
  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(RoomType.name) private readonly types: Model<RoomType>,
    @InjectModel(FolioLine.name) private readonly folioLines: Model<FolioLine>,
    @InjectModel(Kot.name) private readonly kotModel: Model<Kot>,
    @InjectModel(ServiceRequest.name) private readonly requestModel: Model<ServiceRequest>,
    @InjectModel(Feedback.name) private readonly feedbacks: Model<Feedback>,
    private readonly scope: GuestScopeService,
    private readonly folio: FolioService,
    private readonly kots: KotsService,
    private readonly bookings: BookingsService,
    private readonly requests: ServiceRequestsService,
    private readonly dates: BusinessDateService,
  ) {}

  async me(user: Principal) {
    const c = await this.scope.customer(user);
    return { id: c._id, name: c.name, phone: c.phone };
  }

  /** All the customer's bookings, newest first, each with its rooms. */
  async listBookings(user: Principal) {
    const customerId = this.scope.customerId(user);
    const bookings = await this.bookingModel.find({ customerId }).sort({ createdAt: -1 }).lean();
    if (!bookings.length) return { bookings: [] };
    const stays = await this.stays.find({ bookingId: { $in: bookings.map((b) => b._id) } }).sort({ createdAt: 1 }).lean();
    const [rooms, balances] = await Promise.all([
      this.rooms.find({ _id: { $in: stays.map((s) => s.roomId) } }).select('number roomTypeId').lean(),
      this.folio.balances(stays.map((s) => s._id)),
    ]);
    const types = await this.types
      .find({ _id: { $in: [...rooms.map((r) => r.roomTypeId), ...bookings.map((b) => b.roomTypeId)] } })
      .select('name')
      .lean();
    const roomOf = new Map(rooms.map((r) => [String(r._id), r]));
    const typeName = (id: unknown) => types.find((t) => String(t._id) === String(id))?.name ?? null;

    return {
      bookings: bookings.map((b) => {
        const own = stays.filter((s) => String(s.bookingId) === String(b._id));
        const nights = Math.max(1, this.dates.daysBetween(b.arrivalDate, b.departureDate));
        // Rooms the desk hasn't assigned yet are listed without a number.
        // Rooms still to be assigned: the booking's lines no stay has taken (older bookings: by count).
        const freeLines = (b.roomLines ?? []).filter((l) => !l.stayId);
        const unassigned = [BookingStatus.CHECKED_OUT].includes(b.status) ? 0 : b.roomLines?.length ? freeLines.length : Math.max(0, b.rooms - own.length);
        const estimate = dec(b.amount).dividedBy(Math.max(1, b.rooms * nights)).toDecimalPlaces(2);
        // Lines not yet taken by a checked-in room, in booking order.
        const openLines = freeLines;
        const roomsOut = [
          ...own.map((s) => {
            const room = roomOf.get(String(s.roomId));
            return {
              stayId: s._id,
              roomNumber: room?.number ?? null,
              roomType: typeName(room?.roomTypeId),
              guests: s.guests ?? 1,
              rate: s.rate,
              guestName: s.guestName,
              status: stayStatus(s.status),
            };
          }),
          ...Array.from({ length: unassigned }, (_, i) => ({
            stayId: null,
            roomNumber: null,
            lineId: openLines[i]?._id ?? null,
            roomType: typeName(openLines[i]?.roomTypeId ?? b.roomTypeId),
            guests: openLines[i]?.guests ?? null,
            rate: openLines[i]?.rate ?? toD128(estimate),
            guestName: b.guestName,
            status: b.status === BookingStatus.CANCELLED ? 'CANCELLED' : 'CONFIRMED',
          })),
        ];
        const tariff = own
          .reduce((t, s) => t.plus(dec(s.rate).times(s.nights)), dec(0))
          .plus(Array.from({ length: unassigned }, (_, i) => dec(openLines[i]?.rate ?? estimate).times(nights)).reduce((t, x) => t.plus(x), dec(0)));
        return {
          id: b._id,
          ref: b.ref,
          status: APP_STATUS[b.status],
          guestName: b.guestName,
          phone: b.phone,
          arrivalDate: b.arrivalDate,
          departureDate: b.departureDate,
          nights,
          pax: b.pax,
          note: b.note,
          createdAt: (b as any).createdAt,
          amount: toD128(own.length ? tariff : dec(b.amount)),
          balance: toD128(own.reduce((t, s) => t.plus(dec(balances.get(String(s._id)))), dec(0))),
          billNos: own.map((s) => s.billNo).filter(Boolean),
          invoiceUrl: '',
          rooms: roomsOut,
        };
      }),
    };
  }

  /** The bill of one booking, across its rooms. Works for past bookings too. */
  async bookingFolio(user: Principal, bookingId: string) {
    const booking = await this.scope.requireBooking(this.scope.customerId(user), bookingId);
    const stays = await this.stays.find({ bookingId: booking._id }).lean();
    const [lines, rooms] = await Promise.all([
      this.folioLines.find({ stayId: { $in: stays.map((s) => s._id) } }).sort({ createdAt: 1 }).lean(),
      this.rooms.find({ _id: { $in: stays.map((s) => s.roomId) } }).select('number').lean(),
    ]);
    const roomNumberOf = new Map(stays.map((s) => [String(s._id), rooms.find((r) => String(r._id) === String(s.roomId))?.number ?? null]));
    const paidLines = lines.filter((l) => l.source === FolioSource.PAYMENT || l.source === FolioSource.REFUND);
    const balance = lines.reduce((t, l) => t.plus(dec(l.amount)), dec(0));
    return {
      bookingId: booking._id,
      lines: lines.map((l) => ({
        id: l._id,
        stayId: l.stayId,
        roomNumber: roomNumberOf.get(String(l.stayId)) ?? null,
        head: l.head,
        amount: l.amount,
        source: l.source,
        createdAt: (l as any).createdAt,
      })),
      balance: toD128(balance),
      paid: toD128(paidLines.reduce((t, l) => t.minus(dec(l.amount)), dec(0))),
      billNos: stays.map((s) => s.billNo).filter(Boolean),
      invoiceUrl: '',
    };
  }

  /** A booking request by a signed-in customer: no OTP, linked to them whatever phone it names. */
  async book(user: Principal, dto: GuestBookingDto) {
    const { booking, priced } = await this.bookings.createFromGuest(dto, undefined, this.scope.customerId(user));
    const summary = BookingsService.summary(booking, priced);
    return { booking: { ...summary, status: APP_STATUS[booking.status] } };
  }

  /** One request per room, sharing a batchId so the app shows one row and staff close each room. */
  async createRequests(user: Principal, dto: GuestServiceRequestDto) {
    const customerId = this.scope.customerId(user);
    const stays = await this.scope.requireActiveStays(customerId, dto.stayIds);
    if (dto.key === ServiceRequestKey.ROOM_SHIFT) {
      // Checked for every room first, so none is created if one is refused.
      const open = await this.requestModel.findOne({ stayId: { $in: stays.map((s) => s._id) }, key: dto.key, status: { $nin: CLOSED_REQUEST_STATUSES } }).lean();
      if (open) throw conflict('SHIFT_REQUEST_OPEN', 'A room shift request is already open for one of these rooms');
    }
    const batchId = new Types.ObjectId();
    for (const stay of stays) await this.requests.create(stay._id, dto.key, dto.note, batchId);
    return (await this.groupedRequests([batchId]))[0];
  }

  async listRequests(user: Principal) {
    const active = await this.scope.activeStays(this.scope.customerId(user));
    const rows = await this.requestModel.find({ stayId: { $in: active.map((s) => s._id) } }).sort({ createdAt: -1 }).lean();
    return this.group(rows);
  }

  async checkoutRequest(user: Principal, dto: GuestCheckoutRequestDto) {
    const stays = await this.scope.requireActiveStays(this.scope.customerId(user), dto.stayIds);
    const batchId = new Types.ObjectId();
    const made = [];
    for (const stay of stays) made.push(await this.requests.requestCheckout(stay._id, dto.note, batchId));
    return (await this.group(made.map((r: any) => (typeof r.toObject === "function" ? r.toObject() : r))))[0];
  }

  async placeOrder(user: Principal, dto: GuestOrderDto) {
    const [stay] = await this.scope.requireActiveStays(this.scope.customerId(user), [dto.stayId]);
    const { stayId: _ignored, ...order } = dto;
    const placed = await this.kots.place({ ...order, stayId: stay._id, source: KotSource.GUEST_APP });
    const room = await this.rooms.findById(stay.roomId).select('number').lean();
    return { ...placed, roomNumber: room?.number ?? null };
  }

  async listOrders(user: Principal) {
    const active = await this.scope.activeStays(this.scope.customerId(user));
    const [kots, rooms] = await Promise.all([
      this.kotModel.find({ stayId: { $in: active.map((s) => s._id) } }).sort({ createdAt: -1 }).lean(),
      this.rooms.find({ _id: { $in: active.map((s) => s.roomId) } }).select('number').lean(),
    ]);
    const numberOf = new Map(active.map((s) => [String(s._id), rooms.find((r) => String(r._id) === String(s.roomId))?.number ?? null]));
    return kots.map((k) => ({ ...k, roomNumber: numberOf.get(String(k.stayId)) ?? null }));
  }

  async feedback(user: Principal, dto: GuestFeedbackDto) {
    const booking = await this.scope.requireBooking(this.scope.customerId(user), dto.bookingId);
    if (![BookingStatus.CHECKED_IN, BookingStatus.CHECKED_OUT].includes(booking.status)) {
      throw badRequest('BOOKING_NOT_STAYED', 'Feedback opens once you have checked in');
    }
    const stay = await this.stays.findOne({ bookingId: booking._id }).sort({ createdAt: 1 }).lean();
    if (!stay) throw badRequest('BOOKING_NOT_STAYED', 'Feedback opens once you have checked in');
    return this.feedbacks.create({ stayId: stay._id, bookingId: booking._id, rating: dto.rating, text: dto.text ?? '' });
  }

  private async groupedRequests(batchIds: Types.ObjectId[]) {
    return this.group(await this.requestModel.find({ batchId: { $in: batchIds } }).sort({ createdAt: 1 }).lean());
  }

  /** Requests sent together become one row with the rooms they cover. */
  private async group(rows: any[]) {
    const stays = await this.stays.find({ _id: { $in: rows.map((r) => r.stayId) } }).select('roomId').lean();
    const rooms = await this.rooms.find({ _id: { $in: stays.map((s) => s.roomId) } }).select('number').lean();
    const numberOf = (stayId: unknown) => {
      const s = stays.find((x) => String(x._id) === String(stayId));
      return rooms.find((r) => String(r._id) === String(s?.roomId))?.number ?? null;
    };
    const groups = new Map<string, any[]>();
    for (const r of rows) {
      const key = String(r.batchId ?? r._id);
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups.entries()].map(([id, items]) => {
      const statuses = items.map((i) => i.status);
      // One status for the row: the same for all, else the least finished one.
      const order = [ServiceRequestStatus.SENT, ServiceRequestStatus.IN_PROGRESS, ServiceRequestStatus.DONE, ServiceRequestStatus.REJECTED, ServiceRequestStatus.EXPIRED];
      const status = statuses.every((s) => s === statuses[0]) ? statuses[0] : order.find((s) => statuses.includes(s));
      const first = items[0];
      return {
        id,
        key: first.key,
        label: first.label,
        status,
        note: first.note,
        remark: first.remark ?? '',
        createdAt: first.createdAt,
        rooms: items.map((i) => ({ requestId: i._id, stayId: i.stayId, roomNumber: numberOf(i.stayId), status: i.status })),
      };
    });
  }
}
