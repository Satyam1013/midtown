import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsBusinessDate, IsClockTime, IsDecimal } from '../../common/dto/common.dto';
import { DebitCredit, PaymentMode } from '../../common/enums';

export class CreateEntryDto {
  @IsBusinessDate()
  @ApiProperty({ type: String })
  businessDate: string;

  @IsClockTime()
  @ApiProperty({ type: String })
  time: string;

  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String, nullable: true })
  roomId?: string | null;

  @IsOptional() @IsString() @MaxLength(100)
  @ApiPropertyOptional({ type: String })
  guestName?: string;

  @IsOptional() @IsString() @MaxLength(20)
  @ApiPropertyOptional({ type: String, nullable: true })
  phone?: string | null;

  @IsOptional() @IsString() @MaxLength(30)
  @ApiPropertyOptional({ type: String, nullable: true })
  vehicle?: string | null;

  @IsString() @IsNotEmpty() @MaxLength(50)
  @ApiProperty({ type: String })
  type: string;

  @IsEnum(PaymentMode)
  @ApiProperty({ enum: PaymentMode })
  mode: PaymentMode;

  @IsEnum(DebitCredit)
  @ApiProperty({ enum: DebitCredit })
  dc: DebitCredit;

  @IsDecimal({ min: '0' })
  @ApiProperty({ type: String })
  amount: string;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  narration?: string;
}

export class UpdateEntryDto {
  @IsOptional() @IsClockTime()
  @ApiPropertyOptional({ type: String })
  time?: string;

  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String, nullable: true })
  roomId?: string | null;

  @IsOptional() @IsString() @MaxLength(100)
  @ApiPropertyOptional({ type: String })
  guestName?: string;

  @IsOptional() @IsString() @MaxLength(20)
  @ApiPropertyOptional({ type: String, nullable: true })
  phone?: string | null;

  @IsOptional() @IsString() @MaxLength(30)
  @ApiPropertyOptional({ type: String, nullable: true })
  vehicle?: string | null;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(50)
  @ApiPropertyOptional({ type: String })
  type?: string;

  @IsOptional() @IsEnum(PaymentMode)
  @ApiPropertyOptional({ enum: PaymentMode })
  mode?: PaymentMode;

  @IsOptional() @IsEnum(DebitCredit)
  @ApiPropertyOptional({ enum: DebitCredit })
  dc?: DebitCredit;

  @IsOptional() @IsDecimal({ min: '0' })
  @ApiPropertyOptional({ type: String })
  amount?: string;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  narration?: string;
}
