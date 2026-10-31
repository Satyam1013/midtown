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
  @IsEnum(ServiceRequestStatus)
  @ApiProperty({ enum: ServiceRequestStatus })
  status: ServiceRequestStatus;
}

export class RequestQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(ServiceRequestStatus)
  @ApiPropertyOptional({ enum: ServiceRequestStatus })
  status?: ServiceRequestStatus;
}
