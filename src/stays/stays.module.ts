import { Module } from '@nestjs/common';
import { FolioModule } from '../folio/folio.module';
import { DaybookModule } from '../daybook/daybook.module';
import { EntriesModule } from '../entries/entries.module';
import { StaysController } from './stays.controller';
import { StayViewService } from './stay-view.service';
import { StaysService } from './stays.service';

@Module({ imports: [FolioModule, DaybookModule, EntriesModule], controllers: [StaysController], providers: [StaysService, StayViewService], exports: [StaysService, StayViewService] })
export class StaysModule {}
