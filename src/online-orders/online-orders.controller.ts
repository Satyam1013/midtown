import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Types } from 'mongoose';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, OpenDayOnly, Roles } from '../common/decorators';
import { noPage } from '../daybook/open-day.empty';
import { DateQueryDto } from '../common/dto/common.dto';
import { ALL_STAFF } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { CreateOnlineOrderDto, SetOnlineOrderStatusDto } from './dto/online-order.dto';
import { OnlineOrdersService } from './online-orders.service';

@ApiTags('Restaurant')
@ApiBearerAuth()
@Roles(...ALL_STAFF)
@Controller('online-orders')
export class OnlineOrdersController {
  constructor(private readonly orders: OnlineOrdersService) {}

  @OpenDayOnly({ query: ['date'], empty: noPage })
  @Get()
  list(@Query() q: DateQueryDto) {
    return this.orders.list(q);
  }

  @Post()
  create(@Body() dto: CreateOnlineOrderDto, @CurrentUser() user: Principal) {
    return this.orders.create(dto, user);
  }

  /** Same roles as creating an order. 409 ORDER_CLOSED once DELIVERED or CANCELLED. */
  @Patch(':id')
  setStatus(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: SetOnlineOrderStatusDto, @CurrentUser() user: Principal) {
    return this.orders.setStatus(id, dto.status, user);
  }
}
