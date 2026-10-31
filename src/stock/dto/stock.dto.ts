import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsDecimal } from '../../common/dto/common.dto';

export class AdjustStockDto {
  @IsDecimal()
  @ApiProperty({ type: String })
  delta: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  @ApiProperty({ type: String })
  reason: string;
}
