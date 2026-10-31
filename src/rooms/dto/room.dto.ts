import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { IsDecimal } from '../../common/dto/common.dto';
import { RoomStatus } from '../schemas/room.schema';

export class CreateRoomDto {
  @IsString() @IsNotEmpty() @MaxLength(10)
  @ApiProperty({ type: String })
  number: string;

  @IsInt() @Min(0)
  @ApiProperty({ type: Number })
  floor: number;

  @IsMongoId()
  @ApiProperty({ type: String })
  roomTypeId: string;

  @IsOptional() @IsDecimal({ positive: true })
  @ApiPropertyOptional({ type: String })
  rate?: string;
}

export class SetRoomStatusDto {
  // OCCUPIED and DIRTY are also accepted here so the service can answer with a
  // clear MANUAL_STATUS_NOT_ALLOWED rather than a generic validation error.
  @IsEnum(RoomStatus)
  @ApiProperty({ enum: RoomStatus })
  status: RoomStatus;
}
