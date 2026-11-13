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
import { RequestQueryDto } from './dto/service-request.dto';
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
}
