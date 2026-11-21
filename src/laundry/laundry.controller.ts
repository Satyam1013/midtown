import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { AdminOnly, CurrentUser, Roles } from '../common/decorators';
import { DESK, MANAGEMENT } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CreateLaundryOrderDto, LaundryPricesDto, LaundryQueryDto, UpdateLaundryOrderDto } from './dto/laundry.dto';
import { LaundryService } from './laundry.service';

@ApiTags('Laundry')
@ApiBearerAuth()
@Roles(...MANAGEMENT)
@Controller('laundry')
export class LaundryController {
  constructor(private readonly laundry: LaundryService) {}

  /** { expressPct, items: [{ name, service, price }], custom }: the built-in list until one is saved. */
  @Roles(...DESK)
  @Get('prices')
  prices() {
    return this.laundry.priceList();
  }

  @AdminOnly()
  @Put('prices')
  savePrices(@Body() dto: LaundryPricesDto) {
    return this.laundry.savePriceList(dto);
  }

  @Get('orders')
  list(@Query() q: LaundryQueryDto, @CurrentUser() user: Principal) {
    return this.laundry.list(q, user);
  }

  @Post('orders')
  create(@Body() dto: CreateLaundryOrderDto, @CurrentUser() user: Principal) {
    return this.laundry.create(dto, user);
  }

  /** Status (forward, or CANCELLED) and/or edits while not delivered or cancelled. */
  @Patch('orders/:id')
  update(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateLaundryOrderDto, @CurrentUser() user: Principal) {
    return this.laundry.update(id, dto, user);
  }
}
