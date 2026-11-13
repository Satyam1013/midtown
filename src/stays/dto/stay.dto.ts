import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { IsBusinessDate, IsClockTime, IsDecimal } from '../../common/dto/common.dto';
import { PaymentMode } from '../../common/enums';
import { MAX_GUESTS, MIN_GUESTS } from '../../config/pricing';

export class CheckInDto {
  @ApiProperty({ type: String })
  @IsMongoId()
  roomId: string;

  @ApiProperty({ type: String })
  @IsString() @IsNotEmpty() @MaxLength(100)
  guestName: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @IsString() @MaxLength(30)
  vehicle?: string | null;

  /** Defaults to the current date in the hotel's timezone. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  businessDate?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  checkOut?: string;

  @ApiPropertyOptional({ type: Number })
  @IsOptional() @IsInt() @Min(1)
  nights?: number;

  /** 1–4, default 1. Decides the rate. */
  @ApiPropertyOptional({ type: Number })
  @IsOptional() @IsInt() @Min(MIN_GUESTS) @Max(MAX_GUESTS)
  guests?: number;

  /** Accepted for compatibility and ignored: the server works the rate out. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsDecimal({ positive: true })
  rate?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @IsMongoId()
  bookingId?: string | null;
}

export enum StayPaymentKind {
  ADVANCE = 'ADVANCE',
  PART_PAYMENT = 'PART_PAYMENT',
  REFUND = 'REFUND',
}

export class StayPaymentDto {
  @ApiProperty({ enum: StayPaymentKind })
  @IsEnum(StayPaymentKind)
  kind: StayPaymentKind;

  @ApiProperty({ type: String })
  @IsDecimal({ positive: true })
  amount: string;

  @ApiProperty({ enum: PaymentMode })
  @IsEnum(PaymentMode)
  mode: PaymentMode;

  @ApiProperty({ type: String })
  @IsBusinessDate()
  businessDate: string;

  @ApiProperty({ type: String })
  @IsClockTime()
  time: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(300)
  narration?: string;
}

export class UpdateStayDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100)
  guestName?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @IsString() @MaxLength(30)
  vehicle?: string | null;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  checkOut?: string;

  /** New guest count. Only nights from businessDate onwards are repriced. */
  @ApiPropertyOptional({ type: Number })
  @IsOptional() @IsInt() @Min(MIN_GUESTS) @Max(MAX_GUESTS)
  guests?: number;

  /** The date a guest-count change takes effect; defaults to today. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  businessDate?: string;

  @ApiPropertyOptional({ type: StayPaymentDto })
  @IsOptional() @ValidateNested() @Type(() => StayPaymentDto)
  payment?: StayPaymentDto;
}

export class CheckOutDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  businessDate?: string;
}

export class ShiftRoomDto {
  /** The guest's ROOM_SHIFT service request. Required: shifts happen only on request. */
  @ApiProperty({ type: String })
  @IsMongoId()
  requestId: string;

  @ApiProperty({ type: String })
  @IsMongoId()
  toRoomId: string;

  @ApiProperty({ type: Number })
  @IsInt() @Min(MIN_GUESTS) @Max(MAX_GUESTS)
  guests: number;

  /** Accepted and ignored: the new rate comes from the target room. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsDecimal({ positive: true })
  rate?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(300)
  reason?: string;

  @ApiProperty({ type: String })
  @IsBusinessDate()
  businessDate: string;

  @ApiProperty({ type: String })
  @IsClockTime()
  time: string;
}
