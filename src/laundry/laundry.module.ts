import { Module } from '@nestjs/common';
import { DaybookModule } from '../daybook/daybook.module';
import { EntriesModule } from '../entries/entries.module';
import { LaundryController } from './laundry.controller';
import { LaundryService } from './laundry.service';

@Module({ imports: [DaybookModule, EntriesModule], controllers: [LaundryController], providers: [LaundryService], exports: [LaundryService] })
export class LaundryModule {}
