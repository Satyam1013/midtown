import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { IsDecimal } from '../../common/dto/common.dto';
import { RoomCategory, RoomStatus } from '../schemas/room.schema';

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
}

export class UpdateRoomDto {
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
}
