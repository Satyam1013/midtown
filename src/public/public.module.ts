import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { RoomTypesModule } from '../room-types/room-types.module';
import { PublicBookingsService } from './public-bookings.service';
import { PublicController } from './public.controller';

@Module({ imports: [BookingsModule, RoomTypesModule], controllers: [PublicController], providers: [PublicBookingsService] })
export class PublicModule {}
