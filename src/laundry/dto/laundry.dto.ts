import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsMongoId, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { IsBusinessDate, IsClockTime, IsDecimal, PageQueryDto } from '../../common/dto/common.dto';
import { PaymentMode } from '../../common/enums';
import { LaundryServiceKind, LaundrySource, LaundryStatus } from '../schemas/laundry-order.schema';

export class LaundryItemDto {
  @IsString() @IsNotEmpty() @MaxLength(60)
  @ApiProperty({ type: String })
  name: string;

  @IsEnum(LaundryServiceKind)
  @ApiProperty({ enum: LaundryServiceKind })
  service: LaundryServiceKind;

  @IsInt() @Min(1) @Max(500)
  @ApiProperty({ type: Number })
  qty: number;

  /** Per piece, before GST; staff may change the listed rate for an order. */
  @IsDecimal({ min: '0' })
  @ApiProperty({ type: String })
  price: string;
}

export class CreateLaundryOrderDto {
  @IsEnum(LaundrySource)
  @ApiProperty({ enum: LaundrySource })
  source: LaundrySource;

  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String, nullable: true })
  requestId?: string | null;

  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String, nullable: true })
  stayId?: string | null;

  /** Ignored when a stay is given: the stay's room is used. */
  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String, nullable: true })
  roomId?: string | null;

  @IsOptional() @IsString() @MaxLength(100)
  @ApiPropertyOptional({ type: String })
  guestName?: string;

  @IsOptional() @IsString() @MaxLength(20)
  @ApiPropertyOptional({ type: String })
  phone?: string;

  @IsOptional() @IsBoolean()
  @ApiPropertyOptional({ type: Boolean })
  express?: boolean;

  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String, nullable: true })
  expectedDate?: string | null;

  @IsIn(['ROOM', 'PAY_NOW'])
  @ApiProperty({ enum: ['ROOM', 'PAY_NOW'] })
  billTo: 'ROOM' | 'PAY_NOW';

  @IsOptional() @IsEnum(PaymentMode)
  @ApiPropertyOptional({ enum: PaymentMode })
  mode?: PaymentMode;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => LaundryItemDto)
  @ApiProperty({ type: [LaundryItemDto] })
  items: LaundryItemDto[];

  /** What the app worked out (before GST); must match the server's figure when sent. */
  @IsOptional() @IsDecimal({ min: '0' })
  @ApiPropertyOptional({ type: String })
  amount?: string;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  note?: string;

  /** Ignored: the order is taken on the open business day. */
  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  businessDate?: string;

  @IsOptional() @IsClockTime()
  @ApiPropertyOptional({ type: String })
  time?: string;
}

/** Status change and/or edits; edits only while the order is not delivered or cancelled. */
export class UpdateLaundryOrderDto {
  @IsOptional() @IsEnum(LaundryStatus)
  @ApiPropertyOptional({ enum: LaundryStatus })
  status?: LaundryStatus;

  /** Ignored: delivery money goes to the open business day. */
  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  businessDate?: string;

  @IsOptional() @IsClockTime()
  @ApiPropertyOptional({ type: String })
  time?: string;

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => LaundryItemDto)
  @ApiPropertyOptional({ type: [LaundryItemDto] })
  items?: LaundryItemDto[];

  @IsOptional() @IsBoolean()
  @ApiPropertyOptional({ type: Boolean })
  express?: boolean;

  @IsOptional() @IsDecimal({ min: '0' })
  @ApiPropertyOptional({ type: String })
  amount?: string;

  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String, nullable: true })
  expectedDate?: string | null;

  @IsOptional() @IsIn(['ROOM', 'PAY_NOW'])
  @ApiPropertyOptional({ enum: ['ROOM', 'PAY_NOW'] })
  billTo?: 'ROOM' | 'PAY_NOW';

  @IsOptional() @IsEnum(PaymentMode)
  @ApiPropertyOptional({ enum: PaymentMode })
  mode?: PaymentMode;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  note?: string;
}

export class LaundryQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(LaundryStatus)
  @ApiPropertyOptional({ enum: LaundryStatus })
  status?: LaundryStatus;

  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  date?: string;

  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String })
  stayId?: string;
}

export class LaundryPriceDto {
  @IsString() @IsNotEmpty() @MaxLength(60)
  @ApiProperty({ type: String })
  name: string;

  @IsEnum(LaundryServiceKind)
  @ApiProperty({ enum: LaundryServiceKind })
  service: LaundryServiceKind;

  @IsDecimal({ min: '0' })
  @ApiProperty({ type: String })
  price: string;
}

export class LaundryPricesDto {
  @IsNumber() @Min(0) @Max(500)
  @ApiProperty({ type: Number })
  expressPct: number;

  @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => LaundryPriceDto)
  @ApiProperty({ type: [LaundryPriceDto] })
  items: LaundryPriceDto[];
}
