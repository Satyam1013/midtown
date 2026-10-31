import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBusinessDate } from '../../common/dto/common.dto';
import { IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

const INDIAN_MOBILE = /^(\+?91[ -]?|0)?[6-9]\d{9}$/;
const IsIndianMobile = () => Matches(INDIAN_MOBILE, { message: 'phone must be a valid Indian mobile number' });

export class PublicOtpRequestDto {
  @ApiProperty({ type: String })
  @IsString() @IsIndianMobile()
  phone: string;
}

export class PublicBookingDto {
  @ApiProperty({ type: String })
  @IsString() @IsNotEmpty() @MaxLength(100)
  guestName: string;

  @ApiProperty({ type: String })
  @IsString() @IsIndianMobile()
  phone: string;

  @ApiProperty({ type: String })
  @IsString() @Matches(/^\d{6}$/, { message: 'otp must be 6 digits' })
  otp: string;

  @ApiProperty({ type: String })
  @IsMongoId()
  roomTypeId: string;

  @ApiProperty({ type: Number })
  @IsInt() @Min(1)
  rooms: number;

  @ApiProperty({ type: Number })
  @IsInt() @Min(1)
  pax: number;

  @ApiProperty({ type: String })
  @IsBusinessDate()
  arrivalDate: string;

  @ApiProperty({ type: String })
  @IsBusinessDate()
  departureDate: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}
