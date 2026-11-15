import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHmac, timingSafeEqual } from 'crypto';
import { Connection, Model, mongo, Types } from 'mongoose';
import { Readable } from 'stream';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { badRequest, forbidden, notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { TransactionService } from '../database/transaction.service';
import { CustomerDocument, DocumentType } from './schemas/customer-document.schema';
import { Customer } from './schemas/customer.schema';

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const LINK_TTL_SECONDS = 5 * 60;
const BUCKET = 'customer_document_files';

export interface UploadedFileLike {
  buffer: Buffer;
  originalname: string;
  size: number;
}

/** The real type from the file's first bytes; the name and declared type are not trusted. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(buf.toString('ascii', 8, 12))) {
    return 'image/heic';
  }
  return null;
}

const last4 = (n: string | null) => (n ? n.replace(/\s/g, '').slice(-4) : null);

@Injectable()
export class CustomerDocumentsService {
  private readonly bucket: mongo.GridFSBucket;
  private readonly key: Buffer;

  constructor(
    @InjectConnection() connection: Connection,
    @InjectModel(CustomerDocument.name) private readonly documents: Model<CustomerDocument>,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.bucket = new mongo.GridFSBucket(connection.db!, { bucketName: BUCKET });
    this.key = createHmac('sha256', config.getOrThrow<string>('JWT_ACCESS_SECRET')).update('customer-document-links').digest();
  }

  async upload(customerId: Types.ObjectId, type: DocumentType, number: string | undefined, file: UploadedFileLike | undefined, user: Principal) {
    if (!file?.buffer?.length) throw badRequest('FILE_REQUIRED', 'Attach the document file');
    if (file.size > MAX_DOCUMENT_BYTES) throw badRequest('FILE_TOO_LARGE', 'The file is larger than 5 MB');
    const mimeType = sniffMime(file.buffer);
    if (!mimeType) throw badRequest('UNSUPPORTED_FILE', 'Upload a JPG, PNG, WEBP, HEIC image or a PDF');
    if (!(await this.customers.exists({ _id: customerId }))) throw notFound('Customer');

    // GridFS can't join the transaction: write the file first, remove it if the record fails.
    const fileId = new Types.ObjectId();
    await new Promise<void>((resolve, reject) => {
      Readable.from(file.buffer)
        .pipe(this.bucket.openUploadStreamWithId(fileId, file.originalname, { metadata: { customerId, mimeType } }))
        .on('finish', () => resolve())
        .on('error', reject);
    });
    try {
      const doc = await this.tx.run(async ({ session }) => {
        const [created] = await this.documents.create(
          [
            {
              customerId,
              type,
              number: number?.trim() || null,
              fileId,
              fileName: file.originalname.slice(0, 200),
              mimeType,
              size: file.size,
              uploadedByUserId: userObjectId(user),
            },
          ],
          { session },
        );
        await this.customers.updateOne({ _id: customerId }, { $inc: { documentCount: 1 }, $set: { documentType: type } }, { session });
        await this.audit.record(
          AuditAction.DOCUMENT_UPLOAD,
          null,
          userObjectId(user),
          { customerId, documentId: created._id, type, fileName: created.fileName, mimeType, size: file.size },
          session,
        );
        return created;
      });
      return this.view(doc, user);
    } catch (err) {
      await this.bucket.delete(fileId).catch(() => undefined);
      throw err;
    }
  }

  async list(customerId: Types.ObjectId, user: Principal) {
    const docs = await this.documents.find({ customerId }).sort({ createdAt: -1 }).lean();
    return docs.map((d) => this.view(d, user));
  }

  async remove(customerId: Types.ObjectId, docId: Types.ObjectId, user: Principal) {
    const doc = await this.tx.run(async ({ session }) => {
      const d = await this.documents.findOneAndUpdate({ _id: docId, customerId }, { $set: { deletedAt: new Date() } }, { session });
      if (!d) throw notFound('Document');
      const latest = await this.documents.findOne({ customerId, _id: { $ne: docId } }).sort({ createdAt: -1 }).session(session).lean();
      await this.customers.updateOne(
        { _id: customerId },
        { $inc: { documentCount: -1 }, $set: { documentType: latest?.type ?? null } },
        { session },
      );
      await this.audit.record(AuditAction.DOCUMENT_DELETE, null, userObjectId(user), { customerId, documentId: docId, type: d.type, fileName: d.fileName }, session);
      return d;
    });
    // The ID image itself is not kept once the record is removed.
    await this.bucket.delete(doc.fileId).catch(() => undefined);
    return { deleted: true };
  }

  /** Checks a signed link and returns the file stream; every view is audited. */
  async open(docId: string, exp: string, uid: string, sig: string) {
    if (!Types.ObjectId.isValid(docId) || !Types.ObjectId.isValid(uid) || !/^\d+$/.test(exp ?? '')) throw forbidden('INVALID_LINK', 'This link is not valid');
    const expected = this.sign(docId, Number(exp), uid);
    const given = Buffer.from(sig ?? '', 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw forbidden('INVALID_LINK', 'This link is not valid');
    if (Number(exp) < Math.floor(Date.now() / 1000)) throw forbidden('LINK_EXPIRED', 'This link has expired; reload the page');
    const doc = await this.documents.findById(docId).lean();
    if (!doc) throw notFound('Document');
    await this.audit.record(AuditAction.DOCUMENT_VIEW, null, new Types.ObjectId(uid), { customerId: doc.customerId, documentId: doc._id, type: doc.type }, null);
    return { stream: this.bucket.openDownloadStream(doc.fileId), mimeType: doc.mimeType, fileName: doc.fileName, size: doc.size };
  }

  private view(d: { _id: unknown; type: DocumentType; number: string | null; fileName: string; mimeType: string; size: number; createdAt?: Date }, user: Principal) {
    return {
      id: d._id,
      type: d.type,
      numberLast4: last4(d.number),
      fileName: d.fileName,
      mimeType: d.mimeType,
      size: d.size,
      fileUrl: this.signedUrl(String(d._id), String(userObjectId(user))),
      fileUrlExpiresIn: LINK_TTL_SECONDS,
      createdAt: (d as any).createdAt,
    };
  }

  private signedUrl(docId: string, uid: string) {
    const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    const sig = this.sign(docId, exp, uid).toString('base64url');
    return `/api/v1/files/customer-documents/${docId}?exp=${exp}&u=${uid}&sig=${sig}`;
  }

  private sign(docId: string, exp: number, uid: string) {
    return createHmac('sha256', this.key).update(`${docId}.${exp}.${uid}`).digest();
  }
}
