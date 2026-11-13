import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { CurrentUser, Roles } from '../common/decorators';
import { DESK } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CheckInDto, CheckOutDto, ShiftRoomDto, UpdateStayDto } from './dto/stay.dto';
import { StaysService } from './stays.service';

@ApiTags('Stays')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('stays')
export class StaysController {
  constructor(private readonly stays: StaysService) {}

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

  @HttpCode(200)
  @Post(':id/shift')
  shift(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: ShiftRoomDto, @CurrentUser() user: Principal) {
    return this.stays.shift(id, dto, user);
  }

  @HttpCode(200)
  @Post(':id/checkout')
  checkOut(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: CheckOutDto, @CurrentUser() user: Principal) {
    return this.stays.checkOut(id, dto, user);
  }
}
