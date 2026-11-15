import { Prop, Schema } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { buildSchema, ref } from '../../database/build-schema';

export enum DocumentType {
  AADHAAR = 'AADHAAR',
  DRIVING_LICENCE = 'DRIVING_LICENCE',
  PASSPORT = 'PASSPORT',
  VOTER_ID = 'VOTER_ID',
  PAN = 'PAN',
  OTHER = 'OTHER',
}

// An ID document. The file lives in the private GridFS bucket
// `customer_document_files` and is only served through a short-lived signed
// URL. The full ID number is stored but never returned; responses show the
// last 4 digits.
@Schema({ collection: 'customer_documents', timestamps: true })
export class CustomerDocument {
  @Prop(ref('Customer'))
  customerId: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(DocumentType), required: true })
  type: DocumentType;

  @Prop({ type: String, default: null })
  number: string | null;

  @Prop({ type: Types.ObjectId, required: true })
  fileId: Types.ObjectId;

  @Prop({ required: true })
  fileName: string;

  @Prop({ required: true })
  mimeType: string;

  @Prop({ required: true, min: 1 })
  size: number;

  @Prop(ref('User'))
  uploadedByUserId: Types.ObjectId;
}

export type CustomerDocumentDocument = HydratedDocument<CustomerDocument>;
export const CustomerDocumentSchema = buildSchema(CustomerDocument);
CustomerDocumentSchema.index({ customerId: 1, createdAt: -1 });
