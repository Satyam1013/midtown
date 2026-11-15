import { RoomLineDto, RoomLines } from '../../bookings/dto/room-lines.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { IsBusinessDate, IsDecimal } from '../../common/dto/common.dto';
import { MAX_GUESTS } from '../../config/pricing';
import { RoomCategory } from '../../rooms/schemas/room.schema';

/** Rate fields shared by create and update. All GST excluded. */
class RateFields {
  @IsOptional() @IsDecimal({ positive: true })
  @ApiPropertyOptional({ type: String, description: 'Per night, 1 guest' })
  singleRate?: string;

  @IsOptional() @IsDecimal({ positive: true })
  @ApiPropertyOptional({ type: String, description: 'Per night, 2 guests; at least singleRate' })
  doubleRate?: string;

  @IsOptional() @IsDecimal({ min: '0' })
  @ApiPropertyOptional({ type: String, description: 'Per night, each guest beyond 2' })
  additionalGuestRate?: string;

  /** Most guests per room; a stay holds at most 4. */
  @IsOptional() @IsInt() @Min(1) @Max(MAX_GUESTS)
  @ApiPropertyOptional({ type: Number, description: 'Most guests per room (1-4)' })
  sleeps?: number;

  @IsOptional() @IsString() @MaxLength(60)
  @ApiPropertyOptional({ type: String })
  beds?: string;

  @IsOptional() @IsString() @MaxLength(30)
  @ApiPropertyOptional({ type: String })
  size?: string;

  @IsOptional() @IsString() @MaxLength(500)
  @ApiPropertyOptional({ type: String })
  blurb?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  @ApiPropertyOptional({ type: [String] })
  perks?: string[];

  @IsOptional() @IsInt()
  @ApiPropertyOptional({ type: Number })
  sortOrder?: number;
}

/** PATCH /room-types/:id. `tariff` is the older name for singleRate. */
export class UpdateTariffDto extends RateFields {
  @IsOptional() @IsDecimal({ positive: true })
  @ApiPropertyOptional({ type: String, description: 'Same as singleRate' })
  tariff?: string;
}

export class CreateRoomTypeDto extends RateFields {
  @IsString() @IsNotEmpty() @MaxLength(60)
  @ApiProperty({ type: String })
  name: string;

  @IsOptional() @IsEnum(RoomCategory)
  @ApiPropertyOptional({ enum: RoomCategory })
  category?: RoomCategory;

  @IsDecimal({ positive: true })
  @ApiProperty({ type: String })
  declare singleRate: string;

  @IsDecimal({ positive: true })
  @ApiProperty({ type: String })
  declare doubleRate: string;
}

export class QuoteDto {
  /** Older apps: one room type for all rooms. */
  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String })
  roomTypeId?: string;

  @RoomLines()
  @ApiProperty({ type: [RoomLineDto] })
  rooms: RoomLineDto[];

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  @ApiPropertyOptional({ type: Number })
  pax?: number;

  @ApiProperty({ type: String })
  @IsBusinessDate()
  arrivalDate: string;

  @ApiProperty({ type: String })
  @IsBusinessDate()
  departureDate: string;
}
