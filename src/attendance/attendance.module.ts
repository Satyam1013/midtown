import { Module } from '@nestjs/common';
import { DaybookModule } from '../daybook/daybook.module';
import { AttendanceController } from './attendance.controller';

@Module({ imports: [DaybookModule], controllers: [AttendanceController] })
export class AttendanceModule {}
