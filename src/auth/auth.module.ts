import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { GuestStayGuard } from '../common/guards/guest-stay.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GuestScopeService } from './guest-scope.service';
import { SmsService } from './sms.service';
import { TokenService } from './token.service';

@Global()
@Module({
  imports: [JwtModule.register({}), ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }])],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    SmsService,
    GuestScopeService,
    GuestStayGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [TokenService, GuestScopeService, GuestStayGuard, SmsService],
})
export class AuthModule {}
