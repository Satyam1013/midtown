import { Module } from '@nestjs/common';
import { DaybookModule } from '../daybook/daybook.module';
import { EntriesModule } from '../entries/entries.module';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';

@Module({ imports: [DaybookModule, EntriesModule], controllers: [ServiceRequestsController], providers: [ServiceRequestsService], exports: [ServiceRequestsService] })
export class ServiceRequestsModule {}
