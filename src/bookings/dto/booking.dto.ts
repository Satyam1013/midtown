import { RoomLineDto, RoomLines } from './room-lines.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsEnum, IsIn, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
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

  /** Must be the room's type when given. */
  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String })
  roomTypeId?: string;

  /** The room the booking holds. The booking is for this one room. */
  @IsMongoId()
  @ApiProperty({ type: String })
  roomId: string;

  /** Always 1 room with roomId; accepted as a number or a one-line list for older apps. */
  @IsOptional() @RoomLines()
  @ApiPropertyOptional({ type: [RoomLineDto] })
  rooms?: RoomLineDto[];

  /** Guests in the room; 1 by default. */
  @IsOptional() @IsInt() @Min(1)
  @ApiPropertyOptional({ type: Number })
  pax?: number;

  @IsBusinessDate()
  @ApiProperty({ type: String })
  arrivalDate: string;

  @IsBusinessDate()
  @ApiProperty({ type: String })
  departureDate: string;

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

const statusList = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value));

export class BookingQueryDto extends PageQueryDto {
  /** One status, or several comma-separated. */
  @IsOptional() @statusList() @IsArray() @IsEnum(BookingStatus, { each: true })
  @ApiPropertyOptional({ type: String, example: 'CONFIRMED,ARRIVING' })
  status?: BookingStatus[];

  /** Leave these statuses out, e.g. CHECKED_IN; comma-separated for several. */
  @IsOptional() @statusList() @IsArray() @IsEnum(BookingStatus, { each: true })
  @ApiPropertyOptional({ type: String, example: 'CHECKED_IN' })
  excludeStatus?: BookingStatus[];

  /** Arrival on this date. */
  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  date?: string;

  /** Arrival on or after (inclusive). */
  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  from?: string;

  /** Arrival on or before (inclusive). */
  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  to?: string;
}

/** Statuses the desk may set by editing a booking. */
export const EDITABLE_STATUSES = [BookingStatus.ARRIVING, BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN, BookingStatus.CANCELLED, BookingStatus.NO_SHOW] as const;

/** PATCH /bookings/:id: every field optional; a missing field is left as it is. */
export class UpdateBookingDto {
  @IsOptional() @IsEnum(BookingSource)
  @ApiPropertyOptional({ enum: BookingSource })
  source?: BookingSource;

  /** Unique per source; null or "" clears it. */
  @IsOptional() @IsString() @MaxLength(60)
  @ApiPropertyOptional({ type: String, nullable: true })
  ref?: string | null;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100)
  @ApiPropertyOptional({ type: String })
  guestName?: string;

  @IsOptional() @IsString() @MaxLength(20)
  @ApiPropertyOptional({ type: String })
  phone?: string;

  /** Moves every room of the booking to this type. With a room it must be the room's type. */
  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String })
  roomTypeId?: string;

  /** Move the booking to another room: releases the old one, holds the new one. */
  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String })
  roomId?: string;

  /** Number of rooms. */
  @IsOptional() @IsInt() @Min(1) @Max(10)
  @ApiPropertyOptional({ type: Number })
  rooms?: number;

  /** Total guests, split across the rooms. */
  @IsOptional() @IsInt() @Min(1)
  @ApiPropertyOptional({ type: Number })
  pax?: number;

  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  arrivalDate?: string;

  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  departureDate?: string;

  /** OTA bookings only: what the OTA charged. Other bookings are priced by the server. */
  @IsOptional() @IsDecimal({ min: '0' })
  @ApiPropertyOptional({ type: String })
  amount?: string;

  @IsOptional() @IsString() @MaxLength(40)
  @ApiPropertyOptional({ type: String })
  payment?: string;

  @IsOptional() @IsIn(EDITABLE_STATUSES)
  @ApiPropertyOptional({ enum: EDITABLE_STATUSES })
  status?: (typeof EDITABLE_STATUSES)[number];

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  note?: string;
}
