import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength, Min, IsNumber, IsPositive, Max, ValidateIf } from 'class-validator';
import { IsBusinessDate, IsDecimal } from '../../common/dto/common.dto';
import { ROOM_FEATURES, RoomCategory, RoomFeature, RoomStatus } from '../schemas/room.schema';

export class CreateRoomDto {
  @ApiProperty({ type: String })
  @IsString() @IsNotEmpty() @MaxLength(10)
  number: string;

  @ApiProperty({ type: Number })
  @IsInt() @Min(0)
  floor: number;

  @ApiPropertyOptional({ enum: RoomCategory })
  @IsOptional() @IsEnum(RoomCategory)
  category?: RoomCategory;

  /** Room type by name, e.g. "AC Deluxe". Either this or roomTypeId. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(60)
  roomType?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsMongoId()
  roomTypeId?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsDecimal({ positive: true })
  singleRate?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsDecimal({ positive: true })
  doubleRate?: string;

  /** Legacy. Used as the single rate when singleRate isn't sent. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsDecimal({ positive: true })
  rate?: string;

  @ApiPropertyOptional({ type: [String], enum: ROOM_FEATURES })
  @IsOptional() @IsArray() @ArrayMaxSize(ROOM_FEATURES.length) @IsIn(ROOM_FEATURES, { each: true })
  features?: RoomFeature[];

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  // Guest-facing details. On PATCH, a missing field is left as it is; null or "" clears it.
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(80)
  beds?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500)
  blurb?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(80)
  size?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @IsPositive()
  sizeSqft?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '1-10; null keeps the default of 4' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(10)
  sleeps?: number | null;

  /** Per extra guest per night; null uses ₹300, 0 makes extra guests free. Numbers and strings both accepted. */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(({ value }) => (typeof value === 'number' ? String(value) : value)) @IsDecimal({ min: '0' })
  additionalGuestPrice?: string | null;
}

export class UpdateRoomDto {
  /** Allowed only while the room has no stays. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(10)
  number?: string;

  @ApiPropertyOptional({ type: Number })
  @IsOptional() @IsInt() @Min(0)
  floor?: number;

  /** Same as singleRate. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsDecimal({ positive: true })
  rate?: string;

  @ApiPropertyOptional({ type: [String], enum: ROOM_FEATURES })
  @IsOptional() @IsArray() @ArrayMaxSize(ROOM_FEATURES.length) @IsIn(ROOM_FEATURES, { each: true })
  features?: RoomFeature[];

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  // Guest-facing details. On PATCH, a missing field is left as it is; null or "" clears it.
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(80)
  beds?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500)
  blurb?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(80)
  size?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @IsPositive()
  sizeSqft?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '1-10; null keeps the default of 4' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(10)
  sleeps?: number | null;

  /** Per extra guest per night; null uses ₹300, 0 makes extra guests free. Numbers and strings both accepted. */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(({ value }) => (typeof value === 'number' ? String(value) : value)) @IsDecimal({ min: '0' })
  additionalGuestPrice?: string | null;

  @ApiPropertyOptional({ enum: RoomCategory })
  @IsOptional() @IsEnum(RoomCategory)
  category?: RoomCategory;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(60)
  roomType?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsMongoId()
  roomTypeId?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsDecimal({ positive: true })
  singleRate?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsDecimal({ positive: true })
  doubleRate?: string;
}

export class SetRoomStatusDto {
  // OCCUPIED and DIRTY are also accepted here so the service can answer with a
  // clear MANUAL_STATUS_NOT_ALLOWED rather than a generic validation error.
  @ApiProperty({ enum: RoomStatus })
  @IsEnum(RoomStatus)
  status: RoomStatus;

  /** MAINTENANCE only. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(300)
  reason?: string;

  /** MAINTENANCE only: when the room should be ready again. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  expectedBackDate?: string;
}

export class MaintenanceHistoryQueryDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsMongoId()
  roomId?: string;
}

export class AvailableRoomsQueryDto {
  /** Arrival, inclusive. */
  @ApiProperty({ type: String })
  @IsBusinessDate()
  from: string;

  /** Departure, exclusive: a room leaving that day is free. */
  @ApiProperty({ type: String })
  @IsBusinessDate()
  to: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsMongoId()
  roomTypeId?: string;

  @ApiPropertyOptional({ type: Number })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10)
  guests?: number;
}
