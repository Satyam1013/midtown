import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length, Matches, MaxLength } from 'class-validator';

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
  @IsString() @IsNotEmpty() @MaxLength(10)
  @ApiProperty({ type: String })
  roomNumber: string;

  @IsString() @IsNotEmpty() @MaxLength(20)
  @ApiProperty({ type: String })
  phone: string;
}

export class VerifyOtpDto extends RequestOtpDto {
  @IsString() @Length(6, 6) @Matches(/^\d{6}$/)
  @ApiProperty({ type: String })
  otp: string;
}
