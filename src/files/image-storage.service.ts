import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, mongo, Types } from 'mongoose';
import { Readable } from 'stream';
import { badRequest, notFound } from '../common/errors';
import { sniffMime, UploadedFileLike } from '../customers/customer-documents.service';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const BUCKET = 'public_images';

/**
 * Room and menu photos, in the same MongoDB (GridFS) storage as ID documents
 * but a separate bucket. These are meant to be seen, so they are served
 * publicly at /api/v1/files/images/:id; ID documents never are.
 */
@Injectable()
export class ImageStorageService {
  private readonly bucket: mongo.GridFSBucket;

  constructor(@InjectConnection() connection: Connection) {
    this.bucket = new mongo.GridFSBucket(connection.db!, { bucketName: BUCKET });
  }

  /** Checks the real file type (JPG, PNG or WEBP) and size, then stores it. */
  async save(file: UploadedFileLike | undefined, meta: Record<string, unknown>) {
    if (!file?.buffer?.length) throw badRequest('FILE_REQUIRED', 'Attach a photo');
    if (file.size > MAX_IMAGE_BYTES) throw badRequest('FILE_TOO_LARGE', 'The photo is larger than 5 MB');
    const mimeType = sniffMime(file.buffer);
    if (!mimeType || !IMAGE_TYPES.includes(mimeType)) throw badRequest('UNSUPPORTED_FILE', 'Upload a JPG, PNG or WEBP photo');
    const id = new Types.ObjectId();
    await new Promise<void>((resolve, reject) => {
      Readable.from(file.buffer)
        .pipe(this.bucket.openUploadStreamWithId(id, file.originalname.slice(0, 200), { metadata: { ...meta, mimeType } }))
        .on('finish', () => resolve())
        .on('error', reject);
    });
    return { fileId: id, url: ImageStorageService.url(id) };
  }

  remove(fileId: Types.ObjectId) {
    return this.bucket.delete(fileId).catch(() => undefined);
  }

  async open(id: string) {
    if (!Types.ObjectId.isValid(id)) throw notFound('Image');
    const [file] = await this.bucket.find({ _id: new Types.ObjectId(id) }).toArray();
    if (!file) throw notFound('Image');
    return { stream: this.bucket.openDownloadStream(file._id), mimeType: (file.metadata as any)?.mimeType ?? 'application/octet-stream', size: file.length };
  }

  static url(id: Types.ObjectId | string) {
    return `/api/v1/files/images/${String(id)}`;
  }
}
