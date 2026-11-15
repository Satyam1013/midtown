import { BookingsService } from '../bookings/bookings.service';
import { QuoteDto } from '../room-types/dto/room-type.dto';
import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../common/decorators';
import { RoomTypesService } from '../room-types/room-types.service';
import { PublicBookingDto, PublicOtpRequestDto } from './dto/public-booking.dto';
import { PublicBookingsService } from './public-bookings.service';

// No token: visitors browsing rooms and booking without an account.
@ApiTags('Public')
@Public()
@UseGuards(ThrottlerGuard)
@Controller('public')
export class PublicController {
  constructor(
    private readonly roomTypes: RoomTypesService,
    private readonly bookings: PublicBookingsService,
    private readonly bookingsService: BookingsService,
  ) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('room-types')
  listRoomTypes() {
    return this.roomTypes.list();
  }

  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @HttpCode(200)
  @Post('bookings/request-otp')
  requestOtp(@Body() dto: PublicOtpRequestDto) {
    return this.bookings.requestOtp(dto.phone);
  }

  @Throttle({ default: { limit: 20, ttl: 600_000 } })
  /** The price of a booking before making it; same calculation as the booking. */
  @HttpCode(200)
  @Post('bookings/quote')
  quote(@Body() dto: QuoteDto) {
    return this.bookingsService.quote(dto);
  }

  @Post('bookings')
  book(@Body() dto: PublicBookingDto) {
    return this.bookings.book(dto);
  }
}
