import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { IsBusinessDate, IsClockTime, IsDecimal } from '../../common/dto/common.dto';
import { PaymentMode } from '../../common/enums';

export class CheckInDto {
  @IsMongoId()
  @ApiProperty({ type: String })
  roomId: string;

  @IsString() @IsNotEmpty() @MaxLength(100)
  @ApiProperty({ type: String })
  guestName: string;

  @IsOptional() @IsString() @MaxLength(20)
  @ApiPropertyOptional({ type: String })
  phone?: string;

  @IsOptional() @IsString() @MaxLength(30)
  @ApiPropertyOptional({ type: String, nullable: true })
  vehicle?: string | null;

  /** Defaults to the current date in the hotel's timezone. */
  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  businessDate?: string;

  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  checkOut?: string;

  @IsOptional() @IsInt() @Min(1)
  @ApiPropertyOptional({ type: Number })
  nights?: number;

  /** Ignored unless it differs from the room's rate, which only OWNER may do. */
  @IsOptional() @IsDecimal({ positive: true })
  @ApiPropertyOptional({ type: String })
  rate?: string;

  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String, nullable: true })
  bookingId?: string | null;
}

export enum StayPaymentKind {
  ADVANCE = 'ADVANCE',
  PART_PAYMENT = 'PART_PAYMENT',
  REFUND = 'REFUND',
}

export class StayPaymentDto {
  @IsEnum(StayPaymentKind)
  @ApiProperty({ enum: StayPaymentKind })
  kind: StayPaymentKind;

  @IsDecimal({ positive: true })
  @ApiProperty({ type: String })
  amount: string;

  @IsEnum(PaymentMode)
  @ApiProperty({ enum: PaymentMode })
  mode: PaymentMode;

  @IsBusinessDate()
  @ApiProperty({ type: String })
  businessDate: string;

  @IsClockTime()
  @ApiProperty({ type: String })
  time: string;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  narration?: string;
}

export class UpdateStayDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100)
  @ApiPropertyOptional({ type: String })
  guestName?: string;

  @IsOptional() @IsString() @MaxLength(20)
  @ApiPropertyOptional({ type: String })
  phone?: string;

  @IsOptional() @IsString() @MaxLength(30)
  @ApiPropertyOptional({ type: String, nullable: true })
  vehicle?: string | null;

  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  checkOut?: string;

  @IsOptional() @ValidateNested() @Type(() => StayPaymentDto)
  @ApiPropertyOptional({ type: StayPaymentDto })
  payment?: StayPaymentDto;
}

export class CheckOutDto {
  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  businessDate?: string;
}
