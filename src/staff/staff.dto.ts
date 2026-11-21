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

export class UpdateStaffDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100)
  @ApiPropertyOptional({ type: String })
  name?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40)
  @ApiPropertyOptional({ type: String })
  role?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40)
  @ApiPropertyOptional({ type: String })
  shift?: string;

  /** 10 digits, or "" to clear. */
  @IsOptional() @IsString() @MaxLength(20)
  @ApiPropertyOptional({ type: String })
  phone?: string;

  @IsOptional() @IsDecimal({ min: '0' })
  @ApiPropertyOptional({ type: String })
  salary?: string;
}
