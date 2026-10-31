import { Module } from '@nestjs/common';
import { DaybookModule } from '../daybook/daybook.module';
import { EntriesModule } from '../entries/entries.module';
import { KotsController } from './kots.controller';
import { KotsService } from './kots.service';

@Module({ imports: [DaybookModule, EntriesModule], controllers: [KotsController], providers: [KotsService], exports: [KotsService] })
export class KotsModule {}
