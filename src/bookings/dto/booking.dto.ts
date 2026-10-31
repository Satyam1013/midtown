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

  @IsMongoId()
  @ApiProperty({ type: String })
  roomTypeId: string;

  @IsInt() @Min(1)
  @ApiProperty({ type: Number })
  rooms: number;

  @IsInt() @Min(1)
  @ApiProperty({ type: Number })
  pax: number;

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

  @IsMongoId()
  @ApiProperty({ type: String })
  roomTypeId: string;

  @IsInt() @Min(1)
  @ApiProperty({ type: Number })
  rooms: number;

  @IsInt() @Min(1)
  @ApiProperty({ type: Number })
  pax: number;

  @IsBusinessDate()
  @ApiProperty({ type: String })
  arrivalDate: string;

  @IsBusinessDate()
  @ApiProperty({ type: String })
  departureDate: string;

  /** The figure quoted by the OTA or agreed on the phone. */
  @IsDecimal({ min: '0' })
  @ApiProperty({ type: String })
  amount: string;

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
