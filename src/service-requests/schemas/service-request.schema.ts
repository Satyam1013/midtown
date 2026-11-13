import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, ref } from '../../database/build-schema';

export enum ServiceRequestKey {
  housekeeping = 'housekeeping',
  laundry = 'laundry',
  wifi = 'wifi',
  taxi = 'taxi',
  call = 'call',
  checkout = 'checkout',
  ROOM_SHIFT = 'ROOM_SHIFT',
}

export enum ServiceRequestStatus {
  SENT = 'SENT',
  IN_PROGRESS = 'IN_PROGRESS',
  DONE = 'DONE',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

export const CLOSED_REQUEST_STATUSES = [
  ServiceRequestStatus.DONE,
  ServiceRequestStatus.REJECTED,
  ServiceRequestStatus.EXPIRED,
];

@Schema({ collection: 'service_requests', timestamps: true })
export class ServiceRequest {
  @Prop(ref('Stay'))
  stayId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: Object.values(ServiceRequestKey) })
  key: ServiceRequestKey;

  @Prop({ required: true })
  label: string;

  @Prop({ type: String, default: '' })
  note: string;

  @Prop({ type: String, enum: Object.values(ServiceRequestStatus), default: ServiceRequestStatus.SENT })
  status: ServiceRequestStatus;

  /** Staff note, e.g. why a room shift was rejected. */
  @Prop({ type: String, default: '' })
  remark: string;

  @Prop(ref('User', { required: false }))
  handledByUserId: Types.ObjectId | null;
}

export type ServiceRequestDocument = HydratedDocument<ServiceRequest>;
export const ServiceRequestSchema = buildSchema(ServiceRequest);

ServiceRequestSchema.index({ stayId: 1, createdAt: -1 });
ServiceRequestSchema.index({ status: 1, createdAt: 1 });
ServiceRequestSchema.index({ stayId: 1, key: 1, status: 1 });
