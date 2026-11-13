import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../common/dto/common.dto';
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
