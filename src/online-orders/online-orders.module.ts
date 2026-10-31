import { Module } from '@nestjs/common';
import { OnlineOrdersController } from './online-orders.controller';
import { OnlineOrdersService } from './online-orders.service';

@Module({ controllers: [OnlineOrdersController], providers: [OnlineOrdersService], exports: [OnlineOrdersService] })
export class OnlineOrdersModule {}
