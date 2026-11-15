import { RoomLineDto, RoomLines } from '../../bookings/dto/room-lines.dto';
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

  /** Older apps: the one room type of the booking. New apps send it per room in `rooms`. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsMongoId()
  roomTypeId?: string;

  /** One entry per room: { roomTypeId, guests }. A number (older apps) is split by `pax`. */
  @ApiProperty({ type: [RoomLineDto] })
  @RoomLines()
  rooms: RoomLineDto[];

  /** Total guests; must equal the sum of guests when given. */
  @ApiPropertyOptional({ type: Number })
  @IsOptional() @IsInt() @Min(1)
  pax?: number;

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
