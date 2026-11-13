import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsClockTime, IsDecimal, PageQueryDto } from '../../common/dto/common.dto';
import { PaymentMode } from '../../common/enums';
import { ServiceRequestKey, ServiceRequestStatus } from '../schemas/service-request.schema';

export class CreateServiceRequestDto {
  @IsEnum(ServiceRequestKey)
  @ApiProperty({ enum: ServiceRequestKey })
  key: ServiceRequestKey;

  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  note?: string;
}

export class CheckoutRequestDto {
  @IsOptional() @IsString() @MaxLength(300)
  @ApiPropertyOptional({ type: String })
  note?: string;
}

export class SetRequestStatusDto {
  /** Staff note; required when rejecting. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(300)
  remark?: string;

  @IsEnum(ServiceRequestStatus)
  @ApiProperty({ enum: ServiceRequestStatus })
  status: ServiceRequestStatus;
}

export class RequestQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(ServiceRequestStatus)
  @ApiPropertyOptional({ enum: ServiceRequestStatus })
  status?: ServiceRequestStatus;
}

export class ChargeRequestDto {
  @ApiProperty({ type: String })
  @IsDecimal({ positive: true })
  amount: string;

  /** ROOM: added to the guest's folio. PAY_NOW: paid now, posted to the register. */
  @ApiProperty({ enum: ['ROOM', 'PAY_NOW'] })
  @IsIn(['ROOM', 'PAY_NOW'])
  billTo: 'ROOM' | 'PAY_NOW';

  /** Required for PAY_NOW. */
  @ApiPropertyOptional({ enum: PaymentMode })
  @IsOptional() @IsEnum(PaymentMode)
  mode?: PaymentMode;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsClockTime()
  time?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(300)
  narration?: string;
}
