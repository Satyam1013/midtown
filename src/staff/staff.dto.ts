import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsDecimal } from '../common/dto/common.dto';

export class CreateStaffDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  @ApiProperty({ type: String })
  name: string;

  @IsString() @IsNotEmpty() @MaxLength(40)
  @ApiProperty({ type: String })
  role: string;

  @IsString() @IsNotEmpty() @MaxLength(40)
  @ApiProperty({ type: String })
  shift: string;

  @IsOptional() @IsString() @MaxLength(20)
  @ApiPropertyOptional({ type: String })
  phone?: string;

  @IsDecimal({ min: '0' })
  @ApiProperty({ type: String })
  salary: string;
}
