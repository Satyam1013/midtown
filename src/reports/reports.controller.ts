import { Controller, Get, Param, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { Roles } from '../common/decorators';
import { IsBusinessDate } from '../common/dto/common.dto';
import { MANAGEMENT } from '../common/enums';
import { BusinessDateService } from '../common/services/business-date.service';
import { ReportsService } from './reports.service';

class ReportQueryDto {
  @IsOptional() @IsBusinessDate()
  date?: string;

  @IsOptional() @IsIn(['json', 'xlsx'])
  format?: 'json' | 'xlsx';
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@ApiTags('Reports')
@ApiBearerAuth()
@Roles(...MANAGEMENT)
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly dates: BusinessDateService,
  ) {}

  @Get(':key')
  async get(@Param('key') key: string, @Query() q: ReportQueryDto) {
    const date = q.date ?? this.dates.today();
    const report = await this.reports.build(key, date);
    if (q.format !== 'xlsx') return report;
    return new StreamableFile(await this.reports.toXlsx(report), {
      type: XLSX,
      disposition: `attachment; filename="Midtown-${key}-${date}.xlsx"`,
    });
  }
}
