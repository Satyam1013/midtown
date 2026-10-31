import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { IsBusinessDate, IsClockTime, PageQueryDto } from '../../common/dto/common.dto';
import { PaymentMode } from '../../common/enums';
import { KotBillTo, KotStatus } from '../schemas/kot.schema';

export class KotItemDto {
  @IsMongoId()
  @ApiProperty({ type: String })
  menuItemId: string;

  @IsInt() @Min(1) @Max(100)
  @ApiProperty({ type: Number })
  qty: number;

  @IsOptional() @IsString() @MaxLength(200)
  @ApiPropertyOptional({ type: String })
  note?: string;
}

export class CreateKotDto {
  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String, nullable: true })
  stayId?: string | null;

  @IsOptional() @IsString() @MaxLength(50)
  @ApiPropertyOptional({ type: String, nullable: true })
  tableLabel?: string | null;

  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => KotItemDto)
  @ApiProperty({ type: [KotItemDto] })
  items: KotItemDto[];

  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String, nullable: true })
  waiterId?: string | null;

  @IsEnum(KotBillTo)
  @ApiProperty({ enum: KotBillTo })
  billTo: KotBillTo;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  note?: string;
}

export class GuestOrderDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => KotItemDto)
  @ApiProperty({ type: [KotItemDto] })
  items: KotItemDto[];

  @IsEnum(KotBillTo)
  @ApiProperty({ enum: KotBillTo })
  billTo: KotBillTo;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  note?: string;
}

export class SetKotStatusDto {
  @IsEnum(KotStatus)
  @ApiProperty({ enum: KotStatus })
  status: KotStatus;
}

export class KotQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(KotStatus)
  @ApiPropertyOptional({ enum: KotStatus })
  status?: KotStatus;
}

export class SettleBillDto {
  @IsArray() @ArrayMinSize(1) @IsMongoId({ each: true })
  @ApiProperty({ type: [String] })
  kotIds: string[];

  @IsEnum(PaymentMode)
  @ApiProperty({ enum: PaymentMode })
  mode: PaymentMode;

  @IsBusinessDate()
  @ApiProperty({ type: String })
  businessDate: string;

  @IsClockTime()
  @ApiProperty({ type: String })
  time: string;
}
