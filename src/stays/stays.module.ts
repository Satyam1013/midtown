import { Module } from '@nestjs/common';
import { FolioModule } from '../folio/folio.module';
import { DaybookModule } from '../daybook/daybook.module';
import { EntriesModule } from '../entries/entries.module';
import { StaysController } from './stays.controller';
import { StaysService } from './stays.service';

@Module({ imports: [FolioModule, DaybookModule, EntriesModule], controllers: [StaysController], providers: [StaysService], exports: [StaysService] })
export class StaysModule {}
