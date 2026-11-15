import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../common/decorators';
import { DESK } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { DateOnlyQueryDto } from '../daybook/dto/daybook.dto';
import { CreateExpenseDto, ExpenseListQueryDto, ExpensePaymentDto } from './dto/expense.dto';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { Types } from 'mongoose';
import { ExpensesService } from './expenses.service';

@ApiTags('Back office')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  list(@Query() q: ExpenseListQueryDto) {
    return this.expenses.list(q);
  }

  @Get('summary')
  summary(@Query() q: DateOnlyQueryDto) {
    return this.expenses.summary(q.date);
  }

  @HttpCode(201)
  @Post(':id/payments')
  pay(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: ExpensePaymentDto, @CurrentUser() user: Principal) {
    return this.expenses.pay(id, dto, user);
  }

  @Post()
  create(@Body() dto: CreateExpenseDto, @CurrentUser() user: Principal) {
    return this.expenses.create(dto, user);
  }
}
