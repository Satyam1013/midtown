import { Module } from '@nestjs/common';
import { DaybookModule } from '../daybook/daybook.module';
import { EntriesModule } from '../entries/entries.module';
import { OnlineOrdersController } from './online-orders.controller';
import { OnlineOrdersService } from './online-orders.service';

@Module({ imports: [DaybookModule, EntriesModule], controllers: [OnlineOrdersController], providers: [OnlineOrdersService], exports: [OnlineOrdersService] })
export class OnlineOrdersModule {}
