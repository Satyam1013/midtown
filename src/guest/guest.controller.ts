import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { BookingsService } from '../bookings/bookings.service';
import { QuoteDto } from '../room-types/dto/room-type.dto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GuestBookingDto } from '../bookings/dto/booking.dto';
import { CurrentUser, Roles } from '../common/decorators';
import { ALL_STAFF, Role } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { GuestFeedbackDto } from '../feedback/dto/feedback.dto';
import { GuestOrderDto } from '../kots/dto/kot.dto';
import { MenuService } from '../menu/menu.service';
import { RoomTypesService } from '../room-types/room-types.service';
import { GuestCheckoutRequestDto, GuestServiceRequestDto } from '../service-requests/dto/service-request.dto';
import { GuestService } from './guest.service';

// SECURITY: every route works on the customer named by the token. Ids in a
// path or body (bookingId, stayIds, stayId) are checked to be that customer's.
@ApiTags('Guest')
@ApiBearerAuth()
@Roles(Role.GUEST)
@Controller('guest')
export class GuestController {
  constructor(
    private readonly guest: GuestService,
    private readonly menu: MenuService,
    private readonly roomTypes: RoomTypesService,
    private readonly bookingsQuote: BookingsService,
  ) {}

  @Get('me')
  me(@CurrentUser() user: Principal) {
    return this.guest.me(user);
  }

  @Get('bookings')
  bookings(@CurrentUser() user: Principal) {
    return this.guest.listBookings(user);
  }

  @Get('bookings/:bookingId/folio')
  folio(@CurrentUser() user: Principal, @Param('bookingId') bookingId: string) {
    return this.guest.bookingFolio(user, bookingId);
  }

  @Roles(Role.GUEST, Role.VISITOR)
  @HttpCode(200)
  @Post('bookings/quote')
  quote(@Body() dto: QuoteDto) {
    return this.bookingsQuote.quote(dto);
  }

  @Post('bookings')
  book(@CurrentUser() user: Principal, @Body() dto: GuestBookingDto) {
    return this.guest.book(user, dto);
  }

  @Roles(Role.GUEST, Role.VISITOR)
  @Get('menu')
  menuItems() {
    return this.menu.list(true);
  }

  // The manager app also loads room types from here, so staff tokens are allowed.
  @Roles(Role.GUEST, Role.VISITOR, ...ALL_STAFF)
  @Get('room-types')
  listRoomTypes() {
    return this.roomTypes.list();
  }

  @Post('orders')
  placeOrder(@CurrentUser() user: Principal, @Body() dto: GuestOrderDto) {
    return this.guest.placeOrder(user, dto);
  }

  @Get('orders')
  orders(@CurrentUser() user: Principal) {
    return this.guest.listOrders(user);
  }

  @Post('service-requests')
  createRequest(@CurrentUser() user: Principal, @Body() dto: GuestServiceRequestDto) {
    return this.guest.createRequests(user, dto);
  }

  @Get('service-requests')
  listRequests(@CurrentUser() user: Principal) {
    return this.guest.listRequests(user);
  }

  @Post('checkout-request')
  checkoutRequest(@CurrentUser() user: Principal, @Body() dto: GuestCheckoutRequestDto) {
    return this.guest.checkoutRequest(user, dto);
  }

  @Post('feedback')
  giveFeedback(@CurrentUser() user: Principal, @Body() dto: GuestFeedbackDto) {
    return this.guest.feedback(user, dto);
  }
}
