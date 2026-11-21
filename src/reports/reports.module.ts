import { Module } from '@nestjs/common';
import { DaybookModule } from '../daybook/daybook.module';
import { ReportsController } from './reports.controller';
import { RangeReportsService } from './range-reports.service';
import { ReportsService } from './reports.service';

@Module({ imports: [DaybookModule], controllers: [ReportsController], providers: [ReportsService, RangeReportsService], exports: [ReportsService] })
export class ReportsModule {}
