import { Module } from '@nestjs/common';
import { FolioModule } from '../folio/folio.module';
import { MenuModule } from '../menu/menu.module';
import { RoomTypesModule } from '../room-types/room-types.module';
import { KotsModule } from '../kots/kots.module';
import { BookingsModule } from '../bookings/bookings.module';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { GuestController } from './guest.controller';

@Module({ imports: [FolioModule, MenuModule, RoomTypesModule, KotsModule, BookingsModule, ServiceRequestsModule], controllers: [GuestController] })
export class GuestModule {}
