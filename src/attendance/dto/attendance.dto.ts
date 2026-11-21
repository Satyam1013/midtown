import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsMongoId, IsOptional, ValidateNested } from 'class-validator';
import { IsBusinessDate } from '../../common/dto/common.dto';
import { AttendanceMark } from '../schemas/attendance.schema';

const LONG: Record<string, AttendanceMark> = { PRESENT: AttendanceMark.P, ABSENT: AttendanceMark.A, LEAVE: AttendanceMark.L };
/** P / A / L, or PRESENT / ABSENT / LEAVE (any case); stored and returned as P / A / L. */
const MarkValue = () => Transform(({ value }) => (typeof value === 'string' ? (LONG[value.trim().toUpperCase()] ?? value.trim().toUpperCase()) : value));

export class MarkAttendanceDto {
  @IsMongoId()
  @ApiProperty({ type: String })
  staffId: string;

  @IsBusinessDate()
  @ApiProperty({ type: String })
  businessDate: string;

  @MarkValue() @IsEnum(AttendanceMark)
  @ApiProperty({ enum: ['P', 'A', 'L', 'PRESENT', 'ABSENT', 'LEAVE'] })
  mark: AttendanceMark;
}

export class BulkMarkLineDto {
  @IsMongoId()
  @ApiProperty({ type: String })
  staffId: string;

  @MarkValue() @IsEnum(AttendanceMark)
  @ApiProperty({ enum: ['P', 'A', 'L', 'PRESENT', 'ABSENT', 'LEAVE'] })
  mark: AttendanceMark;
}

export class BulkAttendanceDto {
  @IsBusinessDate()
  @ApiProperty({ type: String })
  businessDate: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => BulkMarkLineDto)
  @ApiProperty({ type: [BulkMarkLineDto] })
  marks: BulkMarkLineDto[];
}

/** One day (`date`) or a range (`from`–`to`, at most 366 days), optionally for one person. */
export class AttendanceQueryDto {
  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  date?: string;

  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  from?: string;

  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  to?: string;

  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String })
  staffId?: string;
}
