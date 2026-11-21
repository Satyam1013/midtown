import { Controller, Get, Param, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { HoistData, OpenDayOnly, Roles } from '../common/decorators';
import { IsBusinessDate } from '../common/dto/common.dto';
import { MANAGEMENT } from '../common/enums';
import { BusinessDateService } from '../common/services/business-date.service';
import { emptyEntries, emptySummary, RangeReportsService, REPORT_CATEGORIES, ReportCategory } from './range-reports.service';
import { ReportsService } from './reports.service';

class RangeQueryDto {
  /** Inclusive; defaults to `to`, else the open business day. */
  @ApiPropertyOptional({ type: String, example: '2026-11-01' })
  @IsOptional() @IsBusinessDate()
  from?: string;

  /** Inclusive; defaults to `from`. At most 366 days after `from`. */
  @ApiPropertyOptional({ type: String, example: '2026-11-18' })
  @IsOptional() @IsBusinessDate()
  to?: string;
}

class RangeEntriesQueryDto extends RangeQueryDto {
  @ApiPropertyOptional({ enum: REPORT_CATEGORIES })
  @IsOptional() @IsIn(REPORT_CATEGORIES)
  category?: ReportCategory;

  @ApiPropertyOptional({ type: Number, default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  /** 25 by default; up to 5000 for exports. */
  @ApiPropertyOptional({ type: Number, default: 25, maximum: 5000 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5000)
  limit?: number;
}

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
    private readonly ranges: RangeReportsService,
  ) {}

  /** Totals over a business-date range. Non-admins: the open day only. */
  @HoistData()
  @OpenDayOnly({ query: ['from', 'to'], empty: emptySummary })
  @Get('summary')
  async summary(@Query() q: RangeQueryDto) {
    return this.ranges.summary(await this.ranges.range(q.from, q.to));
  }

  /** Register lines and expenses over a range, newest first, paged; `total` and `totals` cover the whole range. */
  @OpenDayOnly({ query: ['from', 'to'], empty: () => emptyEntries() })
  @Get('entries')
  async entries(@Query() q: RangeEntriesQueryDto) {
    return this.ranges.rows(await this.ranges.range(q.from, q.to), q.category, q.page ?? 1, q.limit ?? 25);
  }

  @OpenDayOnly({ query: ['date'], empty: () => ({ title: '', date: null, head: [], rows: [] }) })
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
