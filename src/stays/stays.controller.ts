import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { CurrentUser, Roles } from '../common/decorators';
import { DESK, MANAGEMENT } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { AddGuestDto, BillPrintDto, CheckInDto, CheckOutDto, ShiftRoomDto, UpdateStayDto } from './dto/stay.dto';
import { StayBillService } from './stay-bill.service';
import { StaysService } from './stays.service';

@ApiTags('Stays')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('stays')
export class StaysController {
  constructor(
    private readonly stays: StaysService,
    private readonly bills: StayBillService,
  ) {}

  /** The guest bill: STAY / FOOD / OTHER sections with CGST + SGST. Provisional until check-out. */
  @Get(':id/bill')
  bill(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.bills.build(id);
  }

  /** Records that a bill was printed. Audit only: no accounting changes. */
  @Post(':id/bill-prints')
  recordPrint(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: BillPrintDto, @CurrentUser() user: Principal) {
    return this.bills.recordPrint(id, dto, user);
  }

  @Roles(...MANAGEMENT)
  @Get(':id/bill-prints')
  listPrints(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.bills.listPrints(id);
  }

  @Post()
  checkIn(@Body() dto: CheckInDto, @CurrentUser() user: Principal) {
    return this.stays.checkIn(dto, user);
  }

  @Get('in-house')
  inHouse() {
    return this.stays.inHouse();
  }

  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateStayDto, @CurrentUser() user: Principal) {
    return this.stays.update(id, dto, user);
  }

  @HttpCode(201)
  @Post(':id/guests')
  addGuest(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: AddGuestDto, @CurrentUser() user: Principal) {
    return this.stays.addGuest(id, dto, user);
  }

  @HttpCode(200)
  @Post(':id/shift')
  shift(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: ShiftRoomDto, @CurrentUser() user: Principal) {
    return this.stays.shift(id, dto, user);
  }

  @HttpCode(200)
  @Post(':id/checkout')
  checkOut(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() dto: CheckOutDto,
    @CurrentUser() user: Principal,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.stays.checkOut(id, dto, user, idempotencyKey);
  }
}
