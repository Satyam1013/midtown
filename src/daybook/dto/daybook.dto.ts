import { ApiProperty } from '@nestjs/swagger';
import { IsBusinessDate, IsDecimal } from '../../common/dto/common.dto';

export class DateOnlyQueryDto {
  @IsBusinessDate()
  @ApiProperty({ type: String })
  date: string;
}

export class SetOpeningDto {
  @IsBusinessDate()
  @ApiProperty({ type: String })
  businessDate: string;

  @IsDecimal()
  @ApiProperty({ type: String })
  openingBalance: string;
}

export class CloseDayDto {
  @IsBusinessDate()
  @ApiProperty({ type: String })
  businessDate: string;
}
