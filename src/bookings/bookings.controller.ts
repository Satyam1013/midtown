import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { AdminOnly, CurrentUser, Roles } from '../common/decorators';
import { DESK, MANAGEMENT } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { BookingsService } from './bookings.service';
import { BookingQueryDto, CreateBookingDto, SetBookingStatusDto, UpdateBookingDto } from './dto/booking.dto';

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

  /** ADMIN and MANAGER. 409 BOOKING_LOCKED for stay fields once a room is checked in. */
  @Roles(...MANAGEMENT)
  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateBookingDto, @CurrentUser() user: Principal) {
    return this.bookings.update(id, dto, user);
  }

  /** ADMIN only. 204; soft delete. 409 BOOKING_IN_USE once a room is checked in (cancel instead). */
  @AdminOnly()
  @HttpCode(204)
  @Delete(':id')
  async remove(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @CurrentUser() user: Principal) {
    await this.bookings.remove(id, user);
  }

  @Patch(':id/status')
  setStatus(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: SetBookingStatusDto) {
    return this.bookings.setStatus(id, dto.status);
  }
}
