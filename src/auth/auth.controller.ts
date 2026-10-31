import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser, HoistData, Public, Roles } from '../common/decorators';
import { ALL_STAFF, Role } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { AuthService } from './auth.service';
import { RefreshDto, RequestOtpDto, StaffLoginDto, VerifyOtpDto } from './dto/auth.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HoistData()
  @HttpCode(200)
  @Post('staff/login')
  login(@Body() dto: StaffLoginDto) {
    return this.auth.staffLogin(dto);
  }

  @Public()
  @HoistData()
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @ApiBearerAuth()
  @Roles(...ALL_STAFF)
  @HttpCode(200)
  @Post('logout')
  logout(@CurrentUser() user: Principal) {
    return this.auth.logout(user);
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('guest/request-otp')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto);
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('guest/verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto);
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('guest/public-token')
  publicToken() {
    return this.auth.publicToken();
  }

  @ApiBearerAuth()
  @Roles(...ALL_STAFF, Role.GUEST, Role.VISITOR)
  @Get('me')
  me(@CurrentUser() user: Principal) {
    return this.auth.me(user);
  }
}
