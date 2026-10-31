import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { CurrentUser, Roles } from '../common/decorators';
import { DESK } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { AdjustStockDto } from './dto/stock.dto';
import { StockService } from './stock.service';

@ApiTags('Back office')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get()
  list() {
    return this.stock.list();
  }

  @HttpCode(200)
  @Post(':id/adjust')
  adjust(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: AdjustStockDto, @CurrentUser() user: Principal) {
    return this.stock.adjust(id, dto.delta, dto.reason, user);
  }
}
