import { Global, Module } from '@nestjs/common';
import { ImagesController } from './files.controller';
import { ImageStorageService } from './image-storage.service';

@Global()
@Module({ controllers: [ImagesController], providers: [ImageStorageService], exports: [ImageStorageService] })
export class FilesModule {}
