import { Module } from '@nestjs/common';
import { FolioService } from './folio.service';

@Module({ providers: [FolioService], exports: [FolioService] })
export class FolioModule {}
