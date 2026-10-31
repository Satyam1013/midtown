import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Role } from '../../common/enums';
import { STAFF_ROLES } from '../schemas/user.schema';

export class CreateUserDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  @ApiProperty({ type: String })
  name: string;

  @IsString() @IsNotEmpty() @MaxLength(20)
  @ApiProperty({ type: String })
  phone: string;

  @IsOptional() @IsEmail()
  @ApiPropertyOptional({ type: String, nullable: true })
  email?: string | null;

  @IsString() @MinLength(8) @MaxLength(200)
  @ApiProperty({ type: String })
  password: string;

  @IsIn(STAFF_ROLES as unknown as string[])
  @ApiProperty({  })
  role: Role;
}

export class UpdateUserDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100)
  @ApiPropertyOptional({ type: String })
  name?: string;

  @IsOptional() @IsEmail()
  @ApiPropertyOptional({ type: String, nullable: true })
  email?: string | null;

  @IsOptional() @IsString() @MinLength(8) @MaxLength(200)
  @ApiPropertyOptional({ type: String })
  password?: string;

  @IsOptional() @IsIn(STAFF_ROLES as unknown as string[])
  @ApiPropertyOptional({  })
  role?: Role;

  @IsOptional() @IsBoolean()
  @ApiPropertyOptional({  })
  active?: boolean;
}
