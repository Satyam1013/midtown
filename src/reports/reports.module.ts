import { Module } from '@nestjs/common';
import { DaybookModule } from '../daybook/daybook.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({ imports: [DaybookModule], controllers: [ReportsController], providers: [ReportsService], exports: [ReportsService] })
export class ReportsModule {}
