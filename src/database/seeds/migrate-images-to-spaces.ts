import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { BlobKind, BlobStoreService } from '../../files/blob-store.service';
import { ImageStorageService } from '../../files/image-storage.service';
import { SeedModule } from './seed.module';

// One-off, idempotent: copies photos and ID documents from MongoDB GridFS to the
// Spaces bucket (same ids), then points room photos and menu items at the
// Spaces links. Files already in Spaces are skipped. GridFS copies are kept;
// drop the GridFS buckets by hand once the app has run on Spaces for a while.
// Needs STORAGE_DRIVER=spaces and the SPACES_* settings.
const log = new Logger('Migrate');

async function main() {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn', 'log'] });
  try {
    const db = app.get<Connection>(getConnectionToken());
    const blobs = new BlobStoreService(db, app.get(ConfigService));
    if (blobs.driver !== 'spaces') throw new Error('Set STORAGE_DRIVER=spaces and the SPACES_* settings first');
    for (const kind of ['images', 'documents'] as BlobKind[]) {
      const bucket = blobs.gridfsBucket(kind);
      let copied = 0;
      let skipped = 0;
      for await (const file of bucket.find({})) {
        if (await blobs.existsInSpaces(kind, file._id)) {
          skipped++;
          continue;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of bucket.openDownloadStream(file._id)) chunks.push(chunk as Buffer);
        const mimeType = (file.metadata as any)?.mimeType ?? 'application/octet-stream';
        await blobs.put(kind, file._id, Buffer.concat(chunks), { mimeType, fileName: file.filename });
        copied++;
      }
      log.log(`${kind}: copied ${copied}, already there ${skipped}`);
    }

    let relinked = 0;
    for (const [collection, field] of [['room_images', 'url'], ['menu_items', 'photoUrl']] as const) {
      for await (const doc of db.collection(collection).find({ [field]: { $regex: '^/api/v1/files/images/' } })) {
        const id = ImageStorageService.idOf(doc[field]);
        if (!id) continue;
        await db.collection(collection).updateOne({ _id: doc._id }, { $set: { [field]: blobs.imageUrl(id) } });
        relinked++;
      }
    }
    log.log(`photo links now on Spaces: ${relinked}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
