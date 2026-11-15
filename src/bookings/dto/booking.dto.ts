import { RoomLineDto, RoomLines } from './room-lines.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { IsBusinessDate, IsDecimal, PageQueryDto } from '../../common/dto/common.dto';
import { BookingSource, BookingStatus } from '../schemas/booking.schema';

export class GuestBookingDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  @ApiProperty({ type: String })
  guestName: string;

  @IsString() @IsNotEmpty() @MaxLength(20)
  @ApiProperty({ type: String })
  phone: string;

  /** Older apps: the one room type of the booking. New apps send it per room in `rooms`. */
  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String })
  roomTypeId?: string;

  /** One entry per room: { roomTypeId, guests }. A number (older apps) is split by `pax`. */
  @RoomLines()
  @ApiProperty({ type: [RoomLineDto] })
  rooms: RoomLineDto[];

  /** Total guests; must equal the sum of guests when given. */
  @IsOptional() @IsInt() @Min(1)
  @ApiPropertyOptional({ type: Number })
  pax?: number;

  @IsBusinessDate()
  @ApiProperty({ type: String })
  arrivalDate: string;

  @IsBusinessDate()
  @ApiProperty({ type: String })
  departureDate: string;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  note?: string;
}

export class CreateBookingDto {
  @IsEnum(BookingSource)
  @ApiProperty({ enum: BookingSource })
  source: BookingSource;

  @IsOptional() @IsString() @MaxLength(60)
  @ApiPropertyOptional({ type: String, nullable: true })
  ref?: string | null;

  @IsString() @IsNotEmpty() @MaxLength(100)
  @ApiProperty({ type: String })
  guestName: string;

  @IsOptional() @IsString() @MaxLength(20)
  @ApiPropertyOptional({ type: String })
  phone?: string;

  /** Older apps: the one room type of the booking. New apps send it per room in `rooms`. */
  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String })
  roomTypeId?: string;

  /** One entry per room: { roomTypeId, guests }. A number (older apps) is split by `pax`. */
  @RoomLines()
  @ApiProperty({ type: [RoomLineDto] })
  rooms: RoomLineDto[];

  /** Total guests; must equal the sum of guests when given. */
  @IsOptional() @IsInt() @Min(1)
  @ApiPropertyOptional({ type: Number })
  pax?: number;

  @IsBusinessDate()
  @ApiProperty({ type: String })
  arrivalDate: string;

  @IsBusinessDate()
  @ApiProperty({ type: String })
  departureDate: string;

  /** The figure quoted by the OTA or agreed on the phone. */
  /** OTA bookings only: what the OTA charged. Ignored otherwise: the server prices the booking. */
  @IsOptional() @IsDecimal({ min: '0' })
  @ApiPropertyOptional({ type: String })
  amount?: string;

  @IsOptional() @IsString() @MaxLength(40)
  @ApiPropertyOptional({ type: String })
  payment?: string;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  note?: string;
}

export class SetBookingStatusDto {
  @IsEnum(BookingStatus)
  @ApiProperty({ enum: BookingStatus })
  status: BookingStatus;
}

export class BookingQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(BookingStatus)
  @ApiPropertyOptional({ enum: BookingStatus })
  status?: BookingStatus;

  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  date?: string;
}
