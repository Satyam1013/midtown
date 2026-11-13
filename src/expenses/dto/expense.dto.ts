import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsBusinessDate, IsClockTime, IsDecimal } from '../../common/dto/common.dto';
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

  @IsEnum(PaymentMode)
  @ApiProperty({ enum: PaymentMode })
  mode: PaymentMode;

  @IsDecimal({ positive: true })
  @ApiProperty({ type: String })
  amount: string;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  narration?: string;
}
