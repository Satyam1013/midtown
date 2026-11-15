import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsDecimal } from '../../common/dto/common.dto';

export class AdjustStockDto {
  @IsDecimal()
  @ApiProperty({ type: String })
  delta: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  @ApiProperty({ type: String })
  reason: string;
}

export class CreateStockItemDto {
  @IsString() @IsNotEmpty() @MaxLength(80)
  @ApiProperty({ type: String })
  item: string;

  @IsString() @IsNotEmpty() @MaxLength(40)
  @ApiProperty({ type: String })
  category: string;

  @IsString() @IsNotEmpty() @MaxLength(20)
  @ApiProperty({ type: String })
  unit: string;

  /** Opening quantity; above 0 it is written as an opening stock movement. */
  @IsOptional() @IsDecimal({ min: '0' })
  @ApiPropertyOptional({ type: String })
  qty?: string;

  @IsOptional() @IsDecimal({ min: '0' })
  @ApiPropertyOptional({ type: String })
  minQty?: string;

  @IsOptional() @IsDecimal({ min: '0' })
  @ApiPropertyOptional({ type: String })
  rate?: string;
}
