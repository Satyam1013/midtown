import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, IsMongoId } from 'class-validator';

export class CreateFeedbackDto {
  @IsInt() @Min(1) @Max(5)
  @ApiProperty({ type: Number })
  rating: number;

  @IsOptional() @IsString() @MaxLength(1000)
  @ApiPropertyOptional({ type: String })
  text?: string;
}

export class GuestFeedbackDto extends CreateFeedbackDto {
  /** A booking of this customer that is checked in or checked out. */
  @IsMongoId()
  @ApiProperty({ type: String })
  bookingId: string;
}
