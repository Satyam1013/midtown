import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { CurrentUser, Roles } from '../common/decorators';
import { ALL_STAFF, DESK } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { oidOrNull, ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CreateKotDto, KotQueryDto, SetKotStatusDto, SettleBillDto } from './dto/kot.dto';
import { KotsService } from './kots.service';
import { KotSource } from './schemas/kot.schema';

@ApiTags('Restaurant')
@ApiBearerAuth()
@Roles(...ALL_STAFF)
@Controller()
export class KotsController {
  constructor(private readonly kots: KotsService) {}

  @Get('kots')
  list(@Query() q: KotQueryDto) {
    return this.kots.list(q);
  }

  @Post('kots')
  create(@Body() dto: CreateKotDto) {
    return this.kots.place({ ...dto, stayId: oidOrNull(dto.stayId), source: KotSource.FRONT_DESK });
  }

  @Patch('kots/:id/status')
  setStatus(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: SetKotStatusDto) {
    return this.kots.setStatus(id, dto.status);
  }

  @Roles(...DESK)
  @HttpCode(200)
  @Post('bills/settle')
  settle(@Body() dto: SettleBillDto, @CurrentUser() user: Principal) {
    return this.kots.settle(dto, user);
  }
}
