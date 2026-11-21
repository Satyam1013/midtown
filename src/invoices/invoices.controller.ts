import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, OpenDayOnly, Roles } from '../common/decorators';
import { noPage } from '../daybook/open-day.empty';
import { DESK } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { CreateInvoiceDto, InvoiceQueryDto } from './dto/invoice.dto';
import { InvoicesService } from './invoices.service';

@ApiTags('Back office')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @OpenDayOnly({ query: ['date'], empty: noPage })
  @Get()
  list(@Query() q: InvoiceQueryDto) {
    return this.invoices.list(q);
  }

  @OpenDayOnly({ body: 'businessDate' })
  @Post()
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: Principal) {
    return this.invoices.create(dto, user);
  }
}
