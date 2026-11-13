import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../common/decorators';
import { DateQueryDto } from '../common/dto/common.dto';
import { DESK } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { DateOnlyQueryDto } from '../daybook/dto/daybook.dto';
import { CreateExpenseDto } from './dto/expense.dto';
import { ExpensesService } from './expenses.service';

@ApiTags('Back office')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  list(@Query() q: DateQueryDto) {
    return this.expenses.list(q);
  }

  @Get('summary')
  summary(@Query() q: DateOnlyQueryDto) {
    return this.expenses.summary(q.date);
  }

  @Post()
  create(@Body() dto: CreateExpenseDto, @CurrentUser() user: Principal) {
    return this.expenses.create(dto, user);
  }
}
