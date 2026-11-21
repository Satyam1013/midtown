import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { AdminOnly, CurrentUser, Roles } from '../common/decorators';
import { DESK, MANAGEMENT } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { AdjustStockDto, CreateStockItemDto, UpdateStockItemDto } from './dto/stock.dto';
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

  @Post()
  create(@Body() dto: CreateStockItemDto, @CurrentUser() user: Principal) {
    return this.stock.create(dto, user);
  }

  /** ADMIN and MANAGER. qty sets the level; the change is logged as an ADJUSTMENT movement. */
  @Roles(...MANAGEMENT)
  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateStockItemDto, @CurrentUser() user: Principal) {
    return this.stock.update(id, dto, user);
  }

  /** ADMIN only. 204; soft delete, history kept. */
  @AdminOnly()
  @HttpCode(204)
  @Delete(':id')
  async remove(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @CurrentUser() user: Principal) {
    await this.stock.remove(id, user);
  }

  /** Stock can't go below zero: 409 INSUFFICIENT_STOCK. */
  @HttpCode(200)
  @Post(':id/adjust')
  adjust(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: AdjustStockDto, @CurrentUser() user: Principal) {
    return this.stock.adjust(id, dto.delta, dto.reason, user);
  }
}
