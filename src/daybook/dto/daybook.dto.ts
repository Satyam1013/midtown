import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsBusinessDate, IsClockTime, IsDecimal } from '../../common/dto/common.dto';

export class DateOnlyQueryDto {
  @ApiProperty({ type: String })
  @IsBusinessDate()
  date: string;
}

export class DateRangeQueryDto {
  @ApiProperty({ type: String })
  @IsBusinessDate()
  from: string;

  @ApiProperty({ type: String })
  @IsBusinessDate()
  to: string;
}

export class SetOpeningDto {
  @ApiProperty({ type: String })
  @IsBusinessDate()
  businessDate: string;

  @ApiProperty({ type: String })
  @IsDecimal()
  openingBalance: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

/** Legacy POST /daybook/close: closes the open day without a cash count. */
export class CloseDayDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  businessDate?: string;
}

export class StartBusinessDayDto {
  /** The date this shift is accounted to; chosen by the desk, not the clock. */
  @ApiProperty({ type: String })
  @IsBusinessDate()
  businessDate: string;

  @ApiProperty({ type: String })
  @IsDecimal()
  openingBalance: string;

  @ApiProperty({ type: String })
  @IsClockTime()
  time: string;

  /** Required when the opening balance differs from the last closing balance. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

export class CloseBusinessDayDto {
  /** Must be the open day's date; guards against closing the wrong shift. */
  @ApiProperty({ type: String })
  @IsBusinessDate()
  businessDate: string;

  @ApiProperty({ type: String })
  @IsDecimal({ min: '0' })
  countedCash: string;

  /** Required when counted cash differs from expected cash. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;

  @ApiProperty({ type: String })
  @IsClockTime()
  time: string;
}

export class ReopenBusinessDayDto {
  @ApiProperty({ type: String })
  @IsBusinessDate()
  businessDate: string;

  @ApiProperty({ type: String })
  @IsString() @IsNotEmpty() @MaxLength(300)
  note: string;
}
