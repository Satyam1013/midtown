import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, mongo, Types } from 'mongoose';
import { Readable } from 'stream';

/** images: room and menu photos, public. documents: guest ID documents, private, only via signed links. */
export type BlobKind = 'images' | 'documents';

export interface StoredBlob {
  stream: Readable;
  mimeType: string;
  size: number;
}

const GRIDFS_BUCKETS: Record<BlobKind, string> = { images: 'public_images', documents: 'customer_document_files' };

/**
 * Where uploaded files live. STORAGE_DRIVER=spaces keeps them in a DigitalOcean
 * Spaces bucket (S3 API): photos public-read under images/, ID documents private
 * under documents/. Anything else (the default) keeps them in MongoDB GridFS.
 *
 * Spaces settings: SPACES_ENDPOINT (https://sgp1.digitaloceanspaces.com),
 * SPACES_REGION (sgp1), SPACES_BUCKET, SPACES_KEY, SPACES_SECRET and, optionally,
 * SPACES_PUBLIC_URL for photo links (e.g. the CDN endpoint); by default
 * https://<bucket>.<region>.cdn.digitaloceanspaces.com.
 */
@Injectable()
export class BlobStoreService {
  private readonly log = new Logger('Storage');
  readonly driver: 'gridfs' | 'spaces';
  private readonly gridfs: Record<BlobKind, mongo.GridFSBucket>;
  private readonly s3: S3Client | null = null;
  private readonly bucket: string = '';
  private readonly publicBase: string = '';

  constructor(@InjectConnection() connection: Connection, config: ConfigService) {
    this.gridfs = {
      images: new mongo.GridFSBucket(connection.db!, { bucketName: GRIDFS_BUCKETS.images }),
      documents: new mongo.GridFSBucket(connection.db!, { bucketName: GRIDFS_BUCKETS.documents }),
    };
    this.driver = String(config.get('STORAGE_DRIVER') ?? '').toLowerCase() === 'spaces' ? 'spaces' : 'gridfs';
    if (this.driver === 'spaces') {
      const region = config.getOrThrow<string>('SPACES_REGION');
      this.bucket = config.getOrThrow<string>('SPACES_BUCKET');
      this.s3 = new S3Client({
        endpoint: config.get<string>('SPACES_ENDPOINT') || `https://${region}.digitaloceanspaces.com`,
        region,
        credentials: { accessKeyId: config.getOrThrow<string>('SPACES_KEY'), secretAccessKey: config.getOrThrow<string>('SPACES_SECRET') },
      });
      this.publicBase = (config.get<string>('SPACES_PUBLIC_URL') || `https://${this.bucket}.${region}.cdn.digitaloceanspaces.com`).replace(/\/+$/, '');
      this.log.log(`Files are stored in Spaces bucket ${this.bucket} (${region})`);
    }
  }

  async put(kind: BlobKind, id: Types.ObjectId, body: Buffer, meta: { mimeType: string; fileName: string; metadata?: Record<string, unknown> }) {
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(kind, id),
          Body: body,
          ContentType: meta.mimeType,
          ACL: kind === 'images' ? 'public-read' : 'private',
          ...(kind === 'images' ? { CacheControl: 'public, max-age=31536000, immutable' } : {}),
        }),
      );
      return;
    }
    await new Promise<void>((resolve, reject) => {
      Readable.from(body)
        .pipe(this.gridfs[kind].openUploadStreamWithId(id, meta.fileName.slice(0, 200), { metadata: { ...meta.metadata, mimeType: meta.mimeType } }))
        .on('finish', () => resolve())
        .on('error', reject);
    });
  }

  /** The file, or null when it isn't there. */
  async open(kind: BlobKind, id: Types.ObjectId): Promise<StoredBlob | null> {
    if (this.s3) {
      try {
        const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(kind, id) }));
        return { stream: out.Body as Readable, mimeType: out.ContentType ?? 'application/octet-stream', size: Number(out.ContentLength ?? 0) };
      } catch (err: any) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    }
    const [file] = await this.gridfs[kind].find({ _id: id }).toArray();
    if (!file) return null;
    return { stream: this.gridfs[kind].openDownloadStream(file._id), mimeType: (file.metadata as any)?.mimeType ?? 'application/octet-stream', size: file.length };
  }

  async delete(kind: BlobKind, id: Types.ObjectId) {
    if (this.s3) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(kind, id) })).catch(() => undefined);
      return;
    }
    await this.gridfs[kind].delete(id).catch(() => undefined);
  }

  /** A photo's link: straight from Spaces (CDN), or served by the API from GridFS. */
  imageUrl(id: Types.ObjectId | string) {
    return this.s3 ? `${this.publicBase}/${this.key('images', id)}` : `/api/v1/files/images/${String(id)}`;
  }

  // ── migration helpers ──
  gridfsBucket(kind: BlobKind) {
    return this.gridfs[kind];
  }

  async existsInSpaces(kind: BlobKind, id: Types.ObjectId) {
    if (!this.s3) return false;
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(kind, id) }));
      return true;
    } catch {
      return false;
    }
  }

  private key(kind: BlobKind, id: Types.ObjectId | string) {
    return `${kind}/${String(id)}`;
  }
}
