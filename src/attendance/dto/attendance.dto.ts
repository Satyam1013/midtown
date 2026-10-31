import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsMongoId } from 'class-validator';
import { IsBusinessDate } from '../../common/dto/common.dto';
import { AttendanceMark } from '../schemas/attendance.schema';

export class MarkAttendanceDto {
  @IsMongoId()
  @ApiProperty({ type: String })
  staffId: string;

  @IsBusinessDate()
  @ApiProperty({ type: String })
  businessDate: string;

  @IsEnum(AttendanceMark)
  @ApiProperty({ enum: AttendanceMark })
  mark: AttendanceMark;
}
