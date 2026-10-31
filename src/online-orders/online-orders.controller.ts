import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../common/decorators';
import { DateQueryDto } from '../common/dto/common.dto';
import { ALL_STAFF } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { CreateOnlineOrderDto } from './dto/online-order.dto';
import { OnlineOrdersService } from './online-orders.service';

@ApiTags('Restaurant')
@ApiBearerAuth()
@Roles(...ALL_STAFF)
@Controller('online-orders')
export class OnlineOrdersController {
  constructor(private readonly orders: OnlineOrdersService) {}

  @Get()
  list(@Query() q: DateQueryDto) {
    return this.orders.list(q);
  }

  @Post()
  create(@Body() dto: CreateOnlineOrderDto, @CurrentUser() user: Principal) {
    return this.orders.create(dto, user);
  }
}
