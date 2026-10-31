import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { pageOf } from '../common/dto/common.dto';
import { notFound } from '../common/errors';
import { Paged } from '../common/interceptors/response.interceptor';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { EventsService } from '../notifications/events.service';
import { RequestQueryDto } from './dto/service-request.dto';
import { ServiceRequest, ServiceRequestKey, ServiceRequestStatus } from './schemas/service-request.schema';

// Labels match the guest app's service list.
const LABELS: Record<ServiceRequestKey, string> = {
  housekeeping: 'Housekeeping',
  laundry: 'Laundry pickup',
  wifi: 'Wi-Fi help',
  taxi: 'Book a taxi',
  call: 'Call front desk',
  checkout: 'Request check-out',
};

@Injectable()
export class ServiceRequestsService {
  constructor(
    @InjectModel(ServiceRequest.name) private readonly requests: Model<ServiceRequest>,
    private readonly events: EventsService,
  ) {}

  async list(q: RequestQueryDto) {
    const { page, limit, skip } = pageOf(q);
    const filter = q.status ? { status: q.status } : {};
    const [items, total] = await Promise.all([
      this.requests.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.requests.countDocuments(filter),
    ]);
    return new Paged(items, { page, limit, total });
  }

  listForStay(stayId: Types.ObjectId) {
    return this.requests.find({ stayId }).sort({ createdAt: -1 }).lean();
  }

  async create(stayId: Types.ObjectId, key: ServiceRequestKey, note?: string) {
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

  async setStatus(id: Types.ObjectId, status: ServiceRequestStatus, user: Principal) {
    const request = await this.requests.findByIdAndUpdate(
      id,
      { $set: { status, handledByUserId: userObjectId(user) } },
      { new: true },
    );
    if (!request) throw notFound('Service request');
    this.events.toHotelAndStay('service-request.updated', request.stayId, {
      id: String(request._id),
      key: request.key,
      status: request.status,
    });
    return request;
  }
}
