import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { CurrentUser, Roles } from '../common/decorators';
import { DESK } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { RequestQueryDto, SetRequestStatusDto } from './dto/service-request.dto';
import { ServiceRequestsService } from './service-requests.service';

@ApiTags('Back office')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('service-requests')
export class ServiceRequestsController {
  constructor(private readonly requests: ServiceRequestsService) {}

  @Get()
  list(@Query() q: RequestQueryDto) {
    return this.requests.list(q);
  }

  @Patch(':id')
  setStatus(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: SetRequestStatusDto, @CurrentUser() user: Principal) {
    return this.requests.setStatus(id, dto.status, user, dto.remark);
  }
}
