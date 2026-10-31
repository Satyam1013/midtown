import { Module } from '@nestjs/common';
import { DaybookModule } from '../daybook/daybook.module';
import { EntriesController } from './entries.controller';
import { EntriesService } from './entries.service';
import { LedgerService } from './ledger.service';

@Module({ imports: [DaybookModule], controllers: [EntriesController], providers: [EntriesService, LedgerService], exports: [EntriesService, LedgerService] })
export class EntriesModule {}
