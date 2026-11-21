import { Global, Module } from '@nestjs/common';
import { ImagesController } from './files.controller';
import { ImageStorageService } from './image-storage.service';
import { BlobStoreService } from './blob-store.service';

@Global()
@Module({ controllers: [ImagesController], providers: [BlobStoreService, ImageStorageService], exports: [BlobStoreService, ImageStorageService] })
export class FilesModule {}
