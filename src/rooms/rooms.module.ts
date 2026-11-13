import { Module } from '@nestjs/common';
import { FolioModule } from '../folio/folio.module';
import { StaysModule } from '../stays/stays.module';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

@Module({ imports: [FolioModule, StaysModule], controllers: [RoomsController], providers: [RoomsService], exports: [RoomsService] })
export class RoomsModule {}
