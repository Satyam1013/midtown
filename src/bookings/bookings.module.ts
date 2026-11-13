import { Module } from '@nestjs/common';
import { RoomTypesModule } from '../room-types/room-types.module';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

@Module({ imports: [RoomTypesModule], controllers: [BookingsController], providers: [BookingsService], exports: [BookingsService] })
export class BookingsModule {}
