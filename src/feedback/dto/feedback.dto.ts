import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateFeedbackDto {
  @IsInt() @Min(1) @Max(5)
  @ApiProperty({ type: Number })
  rating: number;

  @IsOptional() @IsString() @MaxLength(1000)
  @ApiPropertyOptional({ type: String })
  text?: string;
}
