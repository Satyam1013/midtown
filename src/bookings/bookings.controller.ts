import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { Roles } from '../common/decorators';
import { DESK } from '../common/enums';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { BookingsService } from './bookings.service';
import { BookingQueryDto, CreateBookingDto, SetBookingStatusDto } from './dto/booking.dto';

@ApiTags('Back office')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  list(@Query() q: BookingQueryDto) {
    return this.bookings.list(q);
  }

  @Post()
  create(@Body() dto: CreateBookingDto) {
    return this.bookings.create(dto);
  }

  @Patch(':id/status')
  setStatus(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: SetBookingStatusDto) {
    return this.bookings.setStatus(id, dto.status);
  }
}
