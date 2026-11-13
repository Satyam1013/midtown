import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { pageOf } from '../common/dto/common.dto';
import { badRequest, conflict, notFound } from '../common/errors';
import { Paged } from '../common/interceptors/response.interceptor';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { EventsService } from '../notifications/events.service';
import { Stay } from '../stays/schemas/stay.schema';
import { withStayLabels } from '../stays/stay-labels';
import { DebitCredit } from '../common/enums';
import { BusinessDateService } from '../common/services/business-date.service';
import { toD128 } from '../common/utils/money';
import { TransactionService } from '../database/transaction.service';
import { DaybookService } from '../daybook/daybook.service';
import { LedgerService } from '../entries/ledger.service';
import { EntrySource } from '../entries/schemas/day-register-entry.schema';
import { FolioLine, FolioSource } from '../folio/schemas/folio-line.schema';
import { StayStatus } from '../stays/schemas/stay.schema';
import { ChargeRequestDto, RequestQueryDto } from './dto/service-request.dto';
import {
  CLOSED_REQUEST_STATUSES,
  ServiceRequest,
  ServiceRequestKey,
  ServiceRequestStatus,
} from './schemas/service-request.schema';

// Labels match the guest app's service list.
const LABELS: Record<ServiceRequestKey, string> = {
  housekeeping: 'Housekeeping',
  laundry: 'Laundry pickup',
  wifi: 'Wi-Fi help',
  taxi: 'Book a taxi',
  call: 'Call front desk',
  checkout: 'Request check-out',
  ROOM_SHIFT: 'Room shift',
};

@Injectable()
export class ServiceRequestsService {
  constructor(
    @InjectModel(ServiceRequest.name) private readonly requests: Model<ServiceRequest>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    private readonly events: EventsService,
    @InjectModel(FolioLine.name) private readonly folio: Model<FolioLine>,
    private readonly tx: TransactionService,
    private readonly daybook: DaybookService,
    private readonly ledger: LedgerService,
    private readonly dates: BusinessDateService,
  ) {}

  async list(q: RequestQueryDto) {
    const { page, limit, skip } = pageOf(q);
    const filter = q.status ? { status: q.status } : {};
    const [items, total] = await Promise.all([
      this.requests.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.requests.countDocuments(filter),
    ]);
    return new Paged(await withStayLabels(this.stays, items), { page, limit, total });
  }

  listForStay(stayId: Types.ObjectId) {
    return this.requests.find({ stayId }).sort({ createdAt: -1 }).lean();
  }

  async create(stayId: Types.ObjectId, key: ServiceRequestKey, note?: string) {
    if (key === ServiceRequestKey.ROOM_SHIFT) {
      const open = await this.requests.exists({ stayId, key, status: { $nin: CLOSED_REQUEST_STATUSES } });
      if (open) throw conflict('SHIFT_REQUEST_OPEN', 'A room shift request is already open for this stay');
    }
    const request = await this.requests.create({ stayId, key, label: LABELS[key], note: note ?? '' });
    this.events.toHotelAndStay('service-request.created', stayId, { id: String(request._id), key, status: request.status });
    return request;
  }

  /** Asking twice returns the request already open, so the desk sees one. */
  async requestCheckout(stayId: Types.ObjectId, note?: string) {
    const open = await this.requests.findOne({
      stayId,
      key: ServiceRequestKey.checkout,
      status: { $ne: ServiceRequestStatus.DONE },
    });
    return open ?? this.create(stayId, ServiceRequestKey.checkout, note);
  }

  async setStatus(id: Types.ObjectId, status: ServiceRequestStatus, user: Principal, remark?: string) {
    const current = await this.requests.findById(id).select('key status').lean();
    if (!current) throw notFound('Service request');
    if (CLOSED_REQUEST_STATUSES.includes(current.status)) {
      throw conflict('REQUEST_CLOSED', `This request is already ${current.status}`);
    }
    if (current.key === ServiceRequestKey.ROOM_SHIFT && status === ServiceRequestStatus.DONE) {
      throw conflict('USE_SHIFT_ENDPOINT', 'Complete a room shift with POST /stays/:id/shift');
    }
    if (status === ServiceRequestStatus.REJECTED && !remark?.trim()) {
      throw badRequest('REMARK_REQUIRED', 'Say why the request is rejected');
    }
    // Conditional on the status just read, so two desks can't both close it.
    const request = await this.requests.findOneAndUpdate(
      { _id: id, status: current.status },
      { $set: { status, handledByUserId: userObjectId(user), ...(remark !== undefined ? { remark: remark.trim() } : {}) } },
      { new: true },
    );
    if (!request) throw conflict('REQUEST_CHANGED', 'This request was just updated, please refresh');
    this.events.toHotelAndStay('service-request.updated', request.stayId, {
      id: String(request._id),
      key: request.key,
      status: request.status,
    });
    return request;
  }

  /** One charge per request: on the folio (ROOM) or paid now into the register (PAY_NOW). */
  charge(id: Types.ObjectId, dto: ChargeRequestDto, user: Principal) {
    if (dto.billTo === 'PAY_NOW' && !dto.mode) throw badRequest('MODE_REQUIRED', 'Choose how the guest paid');
    return this.tx.run(async ({ session, afterCommit }) => {
      const request = await this.requests.findById(id).session(session);
      if (!request) throw notFound('Service request');
      if (request.chargeAmount) throw conflict('ALREADY_CHARGED', 'This request has already been charged');
      const stay = await this.stays.findById(request.stayId).session(session);
      if (!stay) throw notFound('Stay');

      if (dto.billTo === 'ROOM') {
        if (stay.status !== StayStatus.IN_HOUSE) throw conflict('STAY_NOT_IN_HOUSE', 'The guest has checked out; take payment now');
        const [line] = await this.folio.create(
          [{ stayId: stay._id, head: request.label, amount: toD128(dto.amount), source: FolioSource.OTHER }],
          { session },
        );
        request.chargeFolioLineId = line._id;
        afterCommit(() => this.events.toHotelAndStay('folio.updated', stay._id, { stayId: String(stay._id) }));
      } else {
        const businessDate = await this.daybook.requireOpenDay(session);
        const entry = await this.ledger.post(
          {
            businessDate,
            time: dto.time ?? this.dates.nowTime(),
            roomId: stay.roomId,
            stayId: stay._id,
            guestName: stay.guestName,
            phone: stay.phone,
            vehicle: stay.vehicle,
            type: request.label,
            mode: dto.mode!,
            dc: DebitCredit.CREDIT,
            amount: dto.amount,
            narration: dto.narration ?? `${request.label} charge`,
            source: EntrySource.REQUEST,
            createdByUserId: userObjectId(user),
          },
          session,
        );
        request.chargeEntryId = entry._id;
        afterCommit(() => this.events.toHotel('entry.created', { id: String(entry._id), businessDate }));
      }
      request.chargeAmount = toD128(dto.amount);
      request.chargeBillTo = dto.billTo;
      await request.save({ session });
      afterCommit(() =>
        this.events.toHotelAndStay('service-request.updated', request.stayId, {
          id: String(request._id),
          key: request.key,
          status: request.status,
        }),
      );
      return request;
    });
  }
}
