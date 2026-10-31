import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../common/decorators';
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

  @Get()
  list(@Query() q: InvoiceQueryDto) {
    return this.invoices.list(q);
  }

  @Post()
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: Principal) {
    return this.invoices.create(dto, user);
  }
}
