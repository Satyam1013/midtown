import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { DateQueryDto, IsBusinessDate, IsClockTime, IsDecimal } from '../../common/dto/common.dto';
import { PaymentMode } from '../../common/enums';

export class CreateExpenseDto {
  /** Ignored: postings always go to the open business day. Accepted for older apps. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  businessDate?: string;

  /** Front-desk clock time; defaults to now. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsClockTime()
  time?: string;

  @IsString() @IsNotEmpty() @MaxLength(60)
  @ApiProperty({ type: String })
  head: string;

  @IsOptional() @IsString() @MaxLength(100)
  @ApiPropertyOptional({ type: String })
  vendor?: string;

  /** Required unless onCredit. */
  @IsOptional() @IsEnum(PaymentMode)
  @ApiPropertyOptional({ enum: PaymentMode })
  mode?: PaymentMode;

  @IsDecimal({ positive: true })
  @ApiProperty({ type: String })
  amount: string;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  narration?: string;

  /** Bought on credit: no money moves now; vendor required, no mode. */
  @IsOptional() @IsBoolean()
  @ApiPropertyOptional({ type: Boolean })
  onCredit?: boolean;

  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  dueDate?: string;
}

export class ExpenseListQueryDto extends DateQueryDto {
  /** DUE: every credit expense with something still to pay, any date. */
  @IsOptional() @IsIn(['DUE'])
  @ApiPropertyOptional({ enum: ['DUE'] })
  status?: 'DUE';
}

export class ExpensePaymentDto {
  @IsDecimal({ positive: true })
  @ApiProperty({ type: String })
  amount: string;

  @IsEnum(PaymentMode)
  @ApiProperty({ enum: PaymentMode })
  mode: PaymentMode;

  /** Ignored: payments go to the open business day. */
  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  businessDate?: string;

  @IsOptional() @IsClockTime()
  @ApiPropertyOptional({ type: String })
  time?: string;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  narration?: string;
}
