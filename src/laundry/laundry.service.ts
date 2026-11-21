import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { DebitCredit, PaymentMode, Role } from '../common/enums';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Paged } from '../common/interceptors/response.interceptor';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { BusinessDateService } from '../common/services/business-date.service';
import { GstService } from '../common/services/gst.service';
import { dec, sum, toD128 } from '../common/utils/money';
import { normalizePhone } from '../common/utils/phone';
import { pageOf } from '../common/dto/common.dto';
import { CounterService } from '../database/counter.service';
import { TransactionService } from '../database/transaction.service';
import { DaybookService } from '../daybook/daybook.service';
import { LedgerService } from '../entries/ledger.service';
import { EntrySource } from '../entries/schemas/day-register-entry.schema';
import { FolioLine, FolioSource } from '../folio/schemas/folio-line.schema';
import { EventsService } from '../notifications/events.service';
import { Room } from '../rooms/schemas/room.schema';
import { CLOSED_REQUEST_STATUSES, ServiceRequest, ServiceRequestKey, ServiceRequestStatus } from '../service-requests/schemas/service-request.schema';
import { Stay, StayStatus } from '../stays/schemas/stay.schema';
import { CreateLaundryOrderDto, LaundryItemDto, LaundryPricesDto, LaundryQueryDto, UpdateLaundryOrderDto } from './dto/laundry.dto';
import { LaundryOrder, LaundryOrderDocument, LaundryPriceList, LaundryServiceKind, LaundrySource, LaundryStatus } from './schemas/laundry-order.schema';

const FORWARD = [LaundryStatus.REQUESTED, LaundryStatus.PICKED_UP, LaundryStatus.IN_PROCESS, LaundryStatus.READY, LaundryStatus.DELIVERED];
const FINAL = [LaundryStatus.DELIVERED, LaundryStatus.CANCELLED];
const STAMP: Partial<Record<LaundryStatus, 'pickedUpAt' | 'readyAt' | 'deliveredAt' | 'cancelledAt'>> = {
  [LaundryStatus.PICKED_UP]: 'pickedUpAt',
  [LaundryStatus.READY]: 'readyAt',
  [LaundryStatus.DELIVERED]: 'deliveredAt',
  [LaundryStatus.CANCELLED]: 'cancelledAt',
};

/** Shown on the order and in the day book, e.g. LND-0001. */
export const laundryNumber = (seq: number) => `LND-${String(seq).padStart(4, '0')}`;

/** Used until the hotel saves its own list with PUT /laundry/prices. */
const DEFAULT_PRICES: { name: string; service: LaundryServiceKind; price: string }[] = [
  ...['Shirt', 'T-shirt', 'Trousers', 'Jeans', 'Kurta'].flatMap((name) => [
    { name, service: LaundryServiceKind.WASH, price: '40.00' },
    { name, service: LaundryServiceKind.IRON, price: '20.00' },
    { name, service: LaundryServiceKind.WASH_IRON, price: '60.00' },
    { name, service: LaundryServiceKind.DRY_CLEAN, price: '120.00' },
  ]),
  { name: 'Saree', service: LaundryServiceKind.DRY_CLEAN, price: '250.00' },
  { name: 'Suit (2 pc)', service: LaundryServiceKind.DRY_CLEAN, price: '350.00' },
  { name: 'Jacket', service: LaundryServiceKind.DRY_CLEAN, price: '300.00' },
  { name: 'Towel', service: LaundryServiceKind.WASH, price: '30.00' },
  { name: 'Bedsheet', service: LaundryServiceKind.WASH_IRON, price: '80.00' },
];

@Injectable()
export class LaundryService {
  constructor(
    @InjectModel(LaundryOrder.name) private readonly orders: Model<LaundryOrder>,
    @InjectModel(LaundryPriceList.name) private readonly prices: Model<LaundryPriceList>,
    @InjectModel(ServiceRequest.name) private readonly requests: Model<ServiceRequest>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(FolioLine.name) private readonly folio: Model<FolioLine>,
    private readonly tx: TransactionService,
    private readonly counters: CounterService,
    private readonly daybook: DaybookService,
    private readonly ledger: LedgerService,
    private readonly dates: BusinessDateService,
    private readonly gst: GstService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly config: ConfigService,
  ) {}

  // ── price list ────────────────────────────────────────────────────────────

  /** The express surcharge in %, from the saved list, else LAUNDRY_EXPRESS_PCT, else 50. */
  async priceList() {
    const saved = await this.prices.findOne().lean();
    const envPct = Number(this.config.get<string>('LAUNDRY_EXPRESS_PCT'));
    return {
      expressPct: saved?.expressPct ?? (Number.isFinite(envPct) && this.config.get('LAUNDRY_EXPRESS_PCT') !== undefined ? envPct : 50),
      items: saved ? saved.items.map((i) => ({ name: i.name, service: i.service, price: dec(i.price).toFixed(2) })) : DEFAULT_PRICES,
      custom: !!saved,
    };
  }

  async savePriceList(dto: LaundryPricesDto) {
    await this.prices.updateOne(
      {},
      { $set: { expressPct: dto.expressPct, items: dto.items.map((i) => ({ name: i.name.trim(), service: i.service, price: toD128(i.price) })) } },
      { upsert: true },
    );
    return this.priceList();
  }

  // ── orders ────────────────────────────────────────────────────────────────

  /** Server-side money: items, express surcharge, then GST like any other service. */
  private async price(items: LaundryItemDto[], express: boolean, clientAmount?: string) {
    if (!items.length) throw badRequest('ITEMS_REQUIRED', 'Add at least one item');
    const subtotal = sum(items.map((i) => dec(i.price).times(i.qty))).toDecimalPlaces(2);
    const pct = express ? (await this.priceList()).expressPct : 0;
    const expressCharge = subtotal.times(pct).dividedBy(100).toDecimalPlaces(2);
    const amount = subtotal.plus(expressCharge);
    if (clientAmount !== undefined && !dec(clientAmount).eq(amount)) {
      throw badRequest('AMOUNT_MISMATCH', `The order comes to ${amount.toFixed(2)} (items ${subtotal.toFixed(2)}${express ? ` + ${pct}% express` : ''})`);
    }
    const tax = this.gst.other(amount);
    return {
      items: items.map((i) => ({ name: i.name.trim(), service: i.service, qty: i.qty, price: toD128(i.price) })),
      subtotal: toD128(subtotal),
      expressCharge: toD128(expressCharge),
      amount: toD128(amount),
      gstPct: this.gst.settings.otherPct,
      cgst: toD128(tax.cgst),
      sgst: toD128(tax.sgst),
      total: toD128(tax.total),
    };
  }

  async create(dto: CreateLaundryOrderDto, user: Principal) {
    if (dto.source === LaundrySource.ROOM_REQUEST && !dto.requestId) throw badRequest('REQUEST_REQUIRED', 'Choose the guest request this order is for');
    if (dto.source === LaundrySource.WALK_IN) {
      if (!dto.guestName?.trim()) throw badRequest('GUEST_NAME_REQUIRED', 'Enter the customer’s name');
      if (dto.billTo === 'ROOM') throw badRequest('ROOM_BILL_NEEDS_STAY', 'A walk-in pays now; there is no room bill');
    }
    const money = await this.price(dto.items, !!dto.express, dto.amount);

    const order = await this.tx.run(async ({ session, afterCommit }) => {
      // The guest request, if any, decides the stay.
      let request = null;
      let stayId = dto.stayId ?? null;
      if (dto.requestId) {
        request = await this.requests.findById(dto.requestId).session(session);
        if (!request) throw notFound('Service request');
        if (!String(request.key).toLowerCase().includes('laundry')) throw badRequest('NOT_A_LAUNDRY_REQUEST', 'That request is not for laundry');
        if (CLOSED_REQUEST_STATUSES.includes(request.status)) throw conflict('REQUEST_CLOSED', `That request is already ${request.status}`);
        if (stayId && String(stayId) !== String(request.stayId)) throw badRequest('INVALID_REQUEST', 'That request belongs to another stay');
        stayId = String(request.stayId);
      }
      let stay = null;
      if (dto.source !== LaundrySource.WALK_IN) {
        if (!stayId) throw badRequest('STAY_REQUIRED', 'Choose the in-house guest this order is for');
        stay = await this.stays.findById(stayId).session(session).lean();
        if (!stay || stay.status !== StayStatus.IN_HOUSE) throw badRequest('STAY_NOT_IN_HOUSE', 'A room order needs a guest who is checked in');
      }

      const seq = await this.counters.next('laundry', session);
      const [created] = await this.orders.create(
        [
          {
            seq,
            number: laundryNumber(seq),
            stayId: stay?._id ?? null,
            roomId: stay?.roomId ?? (dto.roomId ? new Types.ObjectId(dto.roomId) : null),
            guestName: dto.guestName?.trim() || stay?.guestName || '',
            phone: normalizePhone(dto.phone) || stay?.phone || '',
            source: dto.source,
            requestId: request?._id ?? null,
            liveRequestId: request?._id ?? null,
            status: LaundryStatus.REQUESTED,
            express: !!dto.express,
            expectedDate: dto.expectedDate ?? null,
            billTo: dto.billTo,
            mode: dto.mode ?? null,
            ...money,
            note: dto.note ?? '',
            businessDate: (await this.daybook.openDate()) ?? this.dates.today(),
            time: dto.time ?? this.dates.nowTime(),
            createdByUserId: userObjectId(user),
          },
        ],
        { session },
      );
      if (request) {
        request.laundryOrderId = created._id;
        if (request.status === ServiceRequestStatus.SENT) request.status = ServiceRequestStatus.IN_PROGRESS;
        request.handledByUserId = userObjectId(user);
        await request.save({ session });
        afterCommit(() => this.announceRequest(request));
      }
      await this.audit.record(AuditAction.LAUNDRY_ORDER, created.stayId, userObjectId(user), { orderId: String(created._id), number: created.number, action: 'CREATE', total: created.total }, session, created.businessDate);
      return created;
    }).catch((err) => {
      if (err?.code === 11000 && /liveRequestId/.test(String(err.message))) throw conflict('REQUEST_HAS_ORDER', 'This request already has a laundry order');
      throw err;
    });
    this.events.toHotel('laundry.updated', { id: String(order._id), status: order.status });
    return this.present(order._id);
  }

  /**
   * Newest first. ADMIN: any day (`date`), or all. Others: the open day plus every
   * order still open, so earlier days' unfinished orders stay in view.
   */
  async list(q: LaundryQueryDto, user: Principal) {
    const { page, limit, skip } = pageOf(q);
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.stayId) filter.stayId = new Types.ObjectId(q.stayId);
    if (user.role === Role.ADMIN) {
      if (q.date) filter.businessDate = q.date;
    } else {
      const open = await this.daybook.openDate();
      if (q.date && q.date !== open) throw forbidden('PAST_DATE_RESTRICTED', 'Only the open business day is available to you');
      filter.$or = [...(open ? [{ businessDate: open }] : []), { status: { $nin: FINAL } }];
    }
    const [items, total] = await Promise.all([
      this.orders.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      this.orders.countDocuments(filter),
    ]);
    return new Paged(await this.withRoomNumbers(items), { page, limit, total });
  }

  async update(id: Types.ObjectId, dto: UpdateLaundryOrderDto, user: Principal) {
    const order = await this.tx.run(async ({ session, afterCommit }) => {
      const o = await this.orders.findById(id).session(session);
      if (!o) throw notFound('Laundry order');
      const from = o.status;
      if (FINAL.includes(from)) throw conflict('ORDER_CLOSED', `This order is ${from.toLowerCase()} and can no longer change`);

      // Edits first, so a delivery in the same call posts the new total.
      const edits: Record<string, unknown> = {};
      if (dto.items || dto.express !== undefined || dto.amount !== undefined) {
        Object.assign(o, await this.price(dto.items ?? o.items.map((i) => ({ ...i, price: String(i.price) })), dto.express ?? o.express, dto.amount));
        o.express = dto.express ?? o.express;
        edits.total = o.total;
      }
      if (dto.expectedDate !== undefined) o.expectedDate = edits.expectedDate = dto.expectedDate;
      if (dto.note !== undefined) o.note = edits.note = dto.note;
      if (dto.mode !== undefined) o.mode = edits.mode = dto.mode;
      if (dto.billTo !== undefined) {
        if (dto.billTo === 'ROOM' && !o.stayId) throw badRequest('ROOM_BILL_NEEDS_STAY', 'This order has no room to bill');
        o.billTo = edits.billTo = dto.billTo;
      }

      const to = dto.status && dto.status !== from ? dto.status : null;
      if (to) {
        if (to !== LaundryStatus.CANCELLED && FORWARD.indexOf(to) < FORWARD.indexOf(from)) {
          throw conflict('INVALID_STATUS_CHANGE', `An order can't go back from ${from} to ${to}`);
        }
        if (to === LaundryStatus.CANCELLED && from === LaundryStatus.READY && user.role !== Role.ADMIN) {
          throw forbidden('FORBIDDEN', 'Admin access required to cancel an order that is ready');
        }
        o.status = to;
        const stamp = STAMP[to];
        if (stamp) o[stamp] = new Date();
        if (to === LaundryStatus.DELIVERED) await this.postMoney(o, dto.time, user, session, afterCommit);
        if (to === LaundryStatus.CANCELLED) o.liveRequestId = null;
        await this.syncRequest(o, to, user, session, afterCommit);
      }
      await o.save({ session });
      await this.audit.record(
        AuditAction.LAUNDRY_ORDER,
        o.stayId,
        userObjectId(user),
        { orderId: String(o._id), number: o.number, action: to ? 'STATUS' : 'EDIT', from, to: to ?? from, edits, total: o.total, entryId: o.entryId, folioLineId: o.folioLineId },
        session,
        o.deliveredDate ?? o.businessDate,
      );
      return o;
    });
    this.events.toHotel('laundry.updated', { id: String(order._id), status: order.status });
    return this.present(order._id);
  }

  /** On delivery: the folio (ROOM) or a day-book credit on the open day (PAY_NOW). */
  private async postMoney(o: LaundryOrderDocument, time: string | undefined, user: Principal, session: ClientSession, afterCommit: (fn: () => void) => void) {
    if (o.billTo === 'ROOM') {
      const stay = await this.stays.findById(o.stayId).session(session).lean();
      if (!stay || stay.status !== StayStatus.IN_HOUSE) throw conflict('STAY_CLOSED', 'The guest has checked out; take payment now (billTo PAY_NOW)');
      const [line] = await this.folio.create(
        [
          {
            stayId: stay._id,
            head: `Laundry ${o.number}`,
            amount: o.total,
            source: FolioSource.OTHER,
            laundryOrderId: o._id,
            gstPct: o.gstPct,
            taxable: o.amount,
            cgst: o.cgst,
            sgst: o.sgst,
          },
        ],
        { session },
      );
      o.folioLineId = line._id;
      o.deliveredDate = (await this.daybook.openDate()) ?? this.dates.today();
      afterCommit(() => this.events.toHotelAndStay('folio.updated', stay._id, { stayId: String(stay._id) }));
      return;
    }
    const mode = o.mode;
    if (!mode) throw badRequest('MODE_REQUIRED', 'Choose how the guest paid');
    const businessDate = await this.daybook.requireOpenDay(session);
    const entry = await this.ledger.post(
      {
        businessDate,
        time: time ?? this.dates.nowTime(),
        roomId: o.roomId,
        stayId: o.stayId,
        guestName: o.guestName,
        phone: o.phone || null,
        type: 'Laundry',
        mode: mode as PaymentMode,
        dc: DebitCredit.CREDIT,
        amount: dec(o.total).toFixed(2),
        narration: `Laundry ${o.number}`,
        source: EntrySource.LAUNDRY,
        createdByUserId: userObjectId(user),
        dupCheck: false,
      },
      session,
    );
    o.entryId = entry._id;
    o.deliveredDate = businessDate;
    afterCommit(() => this.events.toHotel('entry.created', { id: String(entry._id), businessDate }));
  }

  /** The guest's request follows the order: picked up → IN_PROGRESS, delivered → DONE, cancelled → REJECTED. */
  private async syncRequest(o: LaundryOrderDocument, to: LaundryStatus, user: Principal, session: ClientSession, afterCommit: (fn: () => void) => void) {
    if (!o.requestId) return;
    const request = await this.requests.findById(o.requestId).session(session);
    if (!request || CLOSED_REQUEST_STATUSES.includes(request.status)) return;
    if (to === LaundryStatus.DELIVERED) {
      request.status = ServiceRequestStatus.DONE;
      request.remark = 'Laundry delivered';
    } else if (to === LaundryStatus.CANCELLED) {
      request.status = ServiceRequestStatus.REJECTED;
      request.remark = 'Cancelled';
      request.laundryOrderId = null;
    } else {
      request.status = ServiceRequestStatus.IN_PROGRESS;
    }
    request.handledByUserId = userObjectId(user);
    await request.save({ session });
    afterCommit(() => this.announceRequest(request));
  }

  private announceRequest(request: { _id: unknown; stayId: Types.ObjectId; key: ServiceRequestKey; status: ServiceRequestStatus }) {
    this.events.toHotelAndStay('service-request.updated', request.stayId, { id: String(request._id), key: request.key, status: request.status });
  }

  private async present(id: Types.ObjectId) {
    const [row] = await this.withRoomNumbers([(await this.orders.findById(id).lean())!]);
    return row;
  }

  private async withRoomNumbers<T extends { roomId?: Types.ObjectId | null }>(items: T[]) {
    const rooms = await this.rooms.find({ _id: { $in: items.map((o) => o.roomId).filter(Boolean) } }).select('number').setOptions({ withDeleted: true }).lean();
    const numberOf = new Map(rooms.map((r) => [String(r._id), r.number]));
    return items.map((o) => ({ ...o, roomNumber: o.roomId ? (numberOf.get(String(o.roomId)) ?? null) : null }));
  }
}
