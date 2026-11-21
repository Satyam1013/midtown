import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { badRequest, notFound } from '../common/errors';
import { sniffMime, UploadedFileLike } from '../customers/customer-documents.service';
import { BlobStoreService } from './blob-store.service';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Room and menu photos. They are meant to be seen: with Spaces they are public
 * files on the CDN; with GridFS they are served at /api/v1/files/images/:id.
 * ID documents are never public (CustomerDocumentsService).
 */
@Injectable()
export class ImageStorageService {
  constructor(private readonly blobs: BlobStoreService) {}

  /** Checks the real file type (JPG, PNG or WEBP) and size, then stores it. */
  async save(file: UploadedFileLike | undefined, meta: Record<string, unknown>) {
    if (!file?.buffer?.length) throw badRequest('FILE_REQUIRED', 'Attach a photo');
    if (file.size > MAX_IMAGE_BYTES) throw badRequest('FILE_TOO_LARGE', 'The photo is larger than 5 MB');
    const mimeType = sniffMime(file.buffer);
    if (!mimeType || !IMAGE_TYPES.includes(mimeType)) throw badRequest('UNSUPPORTED_FILE', 'Upload a JPG, PNG or WEBP photo');
    const id = new Types.ObjectId();
    await this.blobs.put('images', id, file.buffer, { mimeType, fileName: file.originalname, metadata: meta });
    return { fileId: id, url: this.blobs.imageUrl(id) };
  }

  remove(fileId: Types.ObjectId) {
    return this.blobs.delete('images', fileId);
  }

  /** For /files/images/:id: the file, or (with Spaces) where it lives now. */
  async open(id: string): Promise<{ redirect: string } | { stream: NodeJS.ReadableStream; mimeType: string; size: number }> {
    if (!Types.ObjectId.isValid(id)) throw notFound('Image');
    if (this.blobs.driver === 'spaces') return { redirect: this.blobs.imageUrl(id) };
    const file = await this.blobs.open('images', new Types.ObjectId(id));
    if (!file) throw notFound('Image');
    return file;
  }

  /** The photo id inside any of its links (API path or Spaces URL). */
  static idOf(url: string | null | undefined) {
    return url?.match(/images\/([0-9a-f]{24})(?:$|[/?.])/)?.[1] ?? null;
  }
}
