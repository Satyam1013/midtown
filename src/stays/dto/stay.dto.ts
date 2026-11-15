import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsIn, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { IsBusinessDate, IsClockTime, IsDecimal } from '../../common/dto/common.dto';
import { PaymentMode } from '../../common/enums';
import { MAX_GUESTS, MIN_GUESTS } from '../../config/pricing';

/** Money taken at check-in or check-out. */
export class TakePaymentDto {
  @ApiProperty({ type: String })
  @IsDecimal({ min: '0' })
  amount: string;

  @ApiProperty({ enum: PaymentMode })
  @IsEnum(PaymentMode)
  mode: PaymentMode;

  @ApiProperty({ type: String })
  @IsClockTime()
  time: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(300)
  narration?: string;
}

export class SplitPaymentDto {
  @ApiProperty({ enum: PaymentMode })
  @IsEnum(PaymentMode)
  mode: PaymentMode;

  @ApiProperty({ type: String })
  @IsDecimal({ positive: true })
  amount: string;

  @ApiProperty({ type: String })
  @IsClockTime()
  time: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(300)
  narration?: string;
}

export class CheckInDto {
  @ApiProperty({ type: String })
  @IsMongoId()
  roomId: string;

  @ApiProperty({ type: String })
  @IsString() @IsNotEmpty() @MaxLength(100)
  guestName: string;

  /** A returning customer picked from lookup. Without it the phone finds or creates one. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsMongoId()
  customerId?: string;

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

  /** Advance taken at check-in; posted with the check-in, on the open business day. */
  @ApiPropertyOptional({ type: TakePaymentDto })
  @IsOptional() @ValidateNested() @Type(() => TakePaymentDto)
  advance?: TakePaymentDto;
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

  /** Ignored: payments always go to the open business day. Accepted for older apps. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  businessDate?: string;

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
  /** Ignored: checkout always posts to the open business day. Accepted for older apps. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  businessDate?: string;

  /** Money received at checkout. Anything still owed is recorded as the shortfall. */
  @ApiPropertyOptional({ type: TakePaymentDto })
  @IsOptional() @ValidateNested() @Type(() => TakePaymentDto)
  payment?: TakePaymentDto;

  /** Split payment: one register line per row, all in the checkout's transaction. Use instead of `payment`. */
  @ApiPropertyOptional({ type: [SplitPaymentDto] })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => SplitPaymentDto)
  payments?: SplitPaymentDto[];
}

export class ShiftRoomDto {
  /** The guest's ROOM_SHIFT request, closed as DONE by the shift. Omit for a shift the manager starts. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsMongoId()
  requestId?: string;

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

export class AddGuestDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(100)
  name?: string;

  /** Finds or creates the guest's customer, as at check-in. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(20)
  phone?: string;

  /** The new total number of guests (2–4). */
  @ApiProperty({ type: Number })
  @IsInt() @Min(2)
  guests: number;

  /** Accepted and ignored: the server works the rate out. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsDecimal({ positive: true })
  rate?: string;

  /** The date the guest joins; defaults to the open business day. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  businessDate?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsClockTime()
  time?: string;
}

export class SectionAmountsDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsDecimal({ min: '0' })
  stay?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsDecimal({ min: '0' })
  food?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsDecimal({ min: '0' })
  other?: string;
}

export class BillPrintDto {
  @ApiProperty({ enum: ['MANUAL', 'GENERATED'] })
  @IsIn(['MANUAL', 'GENERATED'])
  type: 'MANUAL' | 'GENERATED';

  @ApiProperty({ enum: ['combined', 'stay', 'food', 'other', 'separate'] })
  @IsIn(['combined', 'stay', 'food', 'other', 'separate'])
  which: 'combined' | 'stay' | 'food' | 'other' | 'separate';

  @ApiProperty({ type: SectionAmountsDto })
  @ValidateNested() @Type(() => SectionAmountsDto)
  amounts: SectionAmountsDto;

  @ApiProperty({ type: SectionAmountsDto })
  @ValidateNested() @Type(() => SectionAmountsDto)
  actualAmounts: SectionAmountsDto;
}
