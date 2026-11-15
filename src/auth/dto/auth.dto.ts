import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class StaffLoginDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  @ApiProperty({ type: String })
  identifier: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  @ApiProperty({ type: String })
  password: string;
}

export class RefreshDto {
  @IsString() @IsNotEmpty()
  @ApiProperty({ type: String })
  refreshToken: string;
}

export class RequestOtpDto {
  /** No longer used: sign-in is by phone alone. Accepted and ignored for older app builds. */
  @IsOptional() @IsString() @MaxLength(10)
  @ApiPropertyOptional({ type: String })
  roomNumber?: string;

  @IsString() @IsNotEmpty() @MaxLength(20)
  @ApiProperty({ type: String })
  phone: string;
}

export class VerifyOtpDto extends RequestOtpDto {
  @IsString() @Length(6, 6) @Matches(/^\d{6}$/)
  @ApiProperty({ type: String })
  otp: string;
}
