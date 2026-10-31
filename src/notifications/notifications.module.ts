import { Global, Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { NotificationsGateway } from './notifications.gateway';

@Global()
@Module({ providers: [EventsService, NotificationsGateway], exports: [EventsService] })
export class NotificationsModule {}
