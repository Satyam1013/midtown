import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, money, ref } from '../../database/build-schema';

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

  /** Shared by the per-room requests a guest sent together, so the app shows them as one. */
  @Prop({ type: Types.ObjectId, default: null })
  batchId: Types.ObjectId | null;

  /** Charge for the service (laundry, taxi …), set once. */
  @Prop(money({ required: false, default: null }))
  chargeAmount: Types.Decimal128 | null;

  /** ROOM: on the folio, paid at checkout. PAY_NOW: a REQUEST line in the register. */
  @Prop({ type: String, enum: ['ROOM', 'PAY_NOW', null], default: null })
  chargeBillTo: 'ROOM' | 'PAY_NOW' | null;

  @Prop(ref('DayRegisterEntry', { required: false }))
  chargeEntryId: Types.ObjectId | null;

  @Prop(ref('FolioLine', { required: false }))
  chargeFolioLineId: Types.ObjectId | null;

  /** Staff note, e.g. why a room shift was rejected. */
  @Prop({ type: String, default: '' })
  remark: string;

  @Prop(ref('User', { required: false }))
  handledByUserId: Types.ObjectId | null;

  /** Laundry requests: the live order made from it; null when none (or it was cancelled). */
  @Prop(ref('LaundryOrder', { required: false }))
  laundryOrderId: Types.ObjectId | null;
}

export type ServiceRequestDocument = HydratedDocument<ServiceRequest>;
export const ServiceRequestSchema = buildSchema(ServiceRequest);

ServiceRequestSchema.index({ batchId: 1 });
ServiceRequestSchema.index({ stayId: 1, createdAt: -1 });
ServiceRequestSchema.index({ status: 1, createdAt: 1 });
ServiceRequestSchema.index({ stayId: 1, key: 1, status: 1 });
