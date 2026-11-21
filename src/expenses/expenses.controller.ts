import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser, OpenDayOnly, Roles } from '../common/decorators';
import { noPage } from '../daybook/open-day.empty';
import { DESK } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { DateOnlyQueryDto } from '../daybook/dto/daybook.dto';
import { CreateExpenseDto, ExpenseListQueryDto, ExpensePaymentDto, UpdateExpenseDto } from './dto/expense.dto';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { Types } from 'mongoose';
import { ExpensesService } from './expenses.service';

@ApiTags('Back office')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @OpenDayOnly({ query: ['date'], empty: noPage })
  @Get()
  list(@Query() q: ExpenseListQueryDto) {
    return this.expenses.list(q);
  }

  @OpenDayOnly({ query: ['date'], empty: () => ({ businessDate: null, total: 0, count: 0, byHead: [] }) })
  @Get('summary')
  summary(@Query() q: DateOnlyQueryDto) {
    return this.expenses.summary(q.date);
  }

  @HttpCode(201)
  @Post(':id/payments')
  pay(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: ExpensePaymentDto, @CurrentUser() user: Principal) {
    return this.expenses.pay(id, dto, user);
  }

  /** ADMIN only. Open day only (409 DAY_CLOSED / DAY_NOT_OPEN); the cash line follows in the same transaction. */
  @AdminOnly()
  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateExpenseDto, @CurrentUser() user: Principal) {
    return this.expenses.update(id, dto, user);
  }

  /** ADMIN only. 204; soft delete with its cash line. 409 EXPENSE_PAYMENTS_EXIST for a credit expense with payments. */
  @AdminOnly()
  @HttpCode(204)
  @Delete(':id')
  async remove(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @CurrentUser() user: Principal) {
    await this.expenses.remove(id, user);
  }

  @Post()
  create(@Body() dto: CreateExpenseDto, @CurrentUser() user: Principal) {
    return this.expenses.create(dto, user);
  }
}
