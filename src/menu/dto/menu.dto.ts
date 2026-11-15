import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsDecimal } from '../../common/dto/common.dto';

export class CreateMenuItemDto {
  @ApiProperty({ type: String })
  @IsString() @IsNotEmpty() @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @ApiProperty({ type: String })
  @IsDecimal({ positive: true })
  price: string;

  @ApiProperty({ type: String })
  @IsString() @IsNotEmpty() @MaxLength(40)
  category: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional() @IsBoolean()
  isVeg?: boolean;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional() @IsBoolean()
  available?: boolean;
}
