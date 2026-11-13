import { Module } from '@nestjs/common';
import { BusinessDayController, DaybookController } from './daybook.controller';
import { DaybookService } from './daybook.service';

@Module({ controllers: [DaybookController, BusinessDayController], providers: [DaybookService], exports: [DaybookService] })
export class DaybookModule {}
