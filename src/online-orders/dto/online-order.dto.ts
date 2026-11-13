import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { IsBusinessDate, IsDecimal } from '../../common/dto/common.dto';

export class OnlineOrderItemDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  @ApiProperty({ type: String })
  name: string;

  @IsInt() @Min(1)
  @ApiProperty({ type: Number })
  qty: number;

  @IsDecimal({ min: '0' })
  @ApiProperty({ type: String })
  price: string;
}

export class CreateOnlineOrderDto {
  /** Ignored: postings always go to the open business day. Accepted for older apps. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  businessDate?: string;

  @IsString() @IsNotEmpty() @MaxLength(30)
  @ApiProperty({ type: String })
  platform: string;

  @IsString() @IsNotEmpty() @MaxLength(60)
  @ApiProperty({ type: String })
  orderId: string;

  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => OnlineOrderItemDto)
  @ApiProperty({ type: [OnlineOrderItemDto] })
  items: OnlineOrderItemDto[];

  @IsDecimal({ positive: true })
  @ApiProperty({ type: String })
  amount: string;

  @IsDecimal({ min: '0' })
  @ApiProperty({ type: String })
  commissionPct: string;

  @IsOptional() @IsString() @MaxLength(30)
  @ApiPropertyOptional({ type: String })
  status?: string;
}
