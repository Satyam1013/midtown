import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { CurrentUser, OpenDayOnly, Roles } from '../common/decorators';
import { forbidden } from '../common/errors';
import { noPage } from '../daybook/open-day.empty';
import { ALL_STAFF, DESK, Role } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { oidOrNull, ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CreateKotDto, KotQueryDto, SetKotStatusDto, SettleBillDto } from './dto/kot.dto';
import { KotsService } from './kots.service';
import { KotSource, KotStatus } from './schemas/kot.schema';

@ApiTags('Restaurant')
@ApiBearerAuth()
@Roles(...ALL_STAFF)
@Controller()
export class KotsController {
  constructor(private readonly kots: KotsService) {}

  /** Newest first, one business day (default: the open day). Non-admins: the open day only. */
  @OpenDayOnly({ query: ['date'], empty: noPage })
  @Get('kots')
  list(@Query() q: KotQueryDto) {
    return this.kots.list(q);
  }

  @Post('kots')
  create(@Body() dto: CreateKotDto) {
    return this.kots.place({ ...dto, stayId: oidOrNull(dto.stayId), source: KotSource.FRONT_DESK });
  }

  /** Status change; `/kots/:id/status` is the older path for the same thing. Cancelling is for the desk, not the kitchen. */
  @Patch(['kots/:id', 'kots/:id/status'])
  setStatus(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: SetKotStatusDto, @CurrentUser() user: Principal) {
    if (dto.status === KotStatus.CANCELLED && user.role === Role.KITCHEN) throw forbidden('FORBIDDEN', 'Only the desk can cancel a KOT');
    return this.kots.setStatus(id, dto.status, user);
  }

  @Roles(...DESK)
  @HttpCode(200)
  @Post('bills/settle')
  settle(@Body() dto: SettleBillDto, @CurrentUser() user: Principal) {
    return this.kots.settle(dto, user);
  }
}
