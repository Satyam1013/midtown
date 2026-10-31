import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BookingsService } from '../bookings/bookings.service';
import { GuestBookingDto } from '../bookings/dto/booking.dto';
import { GuestStay, Roles } from '../common/decorators';
import { ALL_STAFF, Role } from '../common/enums';
import { GuestStayGuard } from '../common/guards/guest-stay.guard';
import { CreateFeedbackDto } from '../feedback/dto/feedback.dto';
import { Feedback } from '../feedback/schemas/feedback.schema';
import { FolioService } from '../folio/folio.service';
import { GuestOrderDto } from '../kots/dto/kot.dto';
import { KotsService } from '../kots/kots.service';
import { KotSource } from '../kots/schemas/kot.schema';
import { MenuService } from '../menu/menu.service';
import { RoomType } from '../room-types/schemas/room-type.schema';
import { RoomTypesService } from '../room-types/room-types.service';
import { Room } from '../rooms/schemas/room.schema';
import { CheckoutRequestDto, CreateServiceRequestDto } from '../service-requests/dto/service-request.dto';
import { ServiceRequestsService } from '../service-requests/service-requests.service';

// SECURITY: no route here takes an id. Stay-scoped routes use GuestStayGuard,
// which resolves the stay from the token, and every query is keyed on that.
@ApiTags('Guest')
@ApiBearerAuth()
@Roles(Role.GUEST)
@Controller('guest')
export class GuestController {
  constructor(
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(RoomType.name) private readonly types: Model<RoomType>,
    @InjectModel(Feedback.name) private readonly feedbacks: Model<Feedback>,
    private readonly folio: FolioService,
    private readonly menu: MenuService,
    private readonly roomTypes: RoomTypesService,
    private readonly kots: KotsService,
    private readonly bookings: BookingsService,
    private readonly requests: ServiceRequestsService,
  ) {}

  @UseGuards(GuestStayGuard)
  @Get('stay')
  async stay(@GuestStay() stay: any) {
    const room = await this.rooms.findById(stay.roomId).select('number floor rate roomTypeId').lean();
    const type = room && (await this.types.findById(room.roomTypeId).select('name tariff').lean());
    return { stay, room: room && { ...room, roomType: type } };
  }

  @UseGuards(GuestStayGuard)
  @Get('folio')
  myFolio(@GuestStay() stay: any) {
    return this.folio.summary(stay._id);
  }

  @Roles(Role.GUEST, Role.VISITOR)
  @Get('menu')
  menuItems() {
    return this.menu.list(true);
  }

  @UseGuards(GuestStayGuard)
  @Post('orders')
  placeOrder(@GuestStay() stay: any, @Body() dto: GuestOrderDto) {
    return this.kots.place({ ...dto, stayId: stay._id, source: KotSource.GUEST_APP });
  }

  @UseGuards(GuestStayGuard)
  @Get('orders')
  orders(@GuestStay() stay: any) {
    return this.kots.listForStay(stay._id);
  }

  // The manager app also loads room types from here, so staff tokens are allowed.
  @Roles(Role.GUEST, Role.VISITOR, ...ALL_STAFF)
  @Get('room-types')
  listRoomTypes() {
    return this.roomTypes.list();
  }

  @Roles(Role.GUEST, Role.VISITOR)
  @Post('bookings')
  book(@Body() dto: GuestBookingDto) {
    return this.bookings.createFromGuest(dto);
  }

  @UseGuards(GuestStayGuard)
  @Post('service-requests')
  createRequest(@GuestStay() stay: any, @Body() dto: CreateServiceRequestDto) {
    return this.requests.create(stay._id, dto.key, dto.note);
  }

  @UseGuards(GuestStayGuard)
  @Get('service-requests')
  listRequests(@GuestStay() stay: any) {
    return this.requests.listForStay(stay._id);
  }

  @UseGuards(GuestStayGuard)
  @Post('checkout-request')
  checkoutRequest(@GuestStay() stay: any, @Body() dto: CheckoutRequestDto) {
    return this.requests.requestCheckout(stay._id, dto.note);
  }

  @UseGuards(GuestStayGuard)
  @Post('feedback')
  giveFeedback(@GuestStay() stay: any, @Body() dto: CreateFeedbackDto) {
    return this.feedbacks.create({ stayId: stay._id, rating: dto.rating, text: dto.text ?? '' });
  }
}
