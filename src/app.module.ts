import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditModule } from './audit/audit.module';
import { CustomersModule } from './customers/customers.module';
import { FilesModule } from './files/files.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { OpenDayInterceptor } from './daybook/open-day.interceptor';
import { DOMAIN_MODULES } from './domain-modules';
import { RoomHoldsModule } from './rooms/room-holds.service';
import { HealthModule } from './health/health.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    DatabaseModule,
    CommonModule,
    AuditModule,
    CustomersModule,
    FilesModule,
    AuthModule,
    NotificationsModule,
    HealthModule,
    RoomHoldsModule,
    ...DOMAIN_MODULES,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    // After ResponseInterceptor, so its early `empty` answers are wrapped like any other.
    { provide: APP_INTERCEPTOR, useClass: OpenDayInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
