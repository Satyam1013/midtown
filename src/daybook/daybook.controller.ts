import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../common/decorators';
import { DESK, MANAGEMENT, Role } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { DaybookService } from './daybook.service';
import {
  CloseBusinessDayDto,
  CloseDayDto,
  DateOnlyQueryDto,
  DateRangeQueryDto,
  ReopenBusinessDayDto,
  SetOpeningDto,
  StartBusinessDayDto,
} from './dto/daybook.dto';

@ApiTags('Day book')
@ApiBearerAuth()
@Controller('daybook')
export class DaybookController {
  constructor(private readonly daybook: DaybookService) {}

  @Roles(...DESK)
  @Get()
  get(@Query() q: DateOnlyQueryDto) {
    return this.daybook.get(q.date);
  }

  /** Every money line of the business day, entries and expenses together. */
  @Roles(...DESK)
  @Get('register')
  register(@Query() q: DateOnlyQueryDto) {
    return this.daybook.register(q.date);
  }

  @Roles(...MANAGEMENT)
  @Get('shortages')
  shortages(@Query() q: DateRangeQueryDto) {
    return this.daybook.shortages(q.from, q.to);
  }

  @Roles(...MANAGEMENT)
  @Patch('opening')
  setOpening(@Body() dto: SetOpeningDto, @CurrentUser() user: Principal) {
    return this.daybook.setOpening(dto.businessDate, dto.openingBalance, user, dto.note);
  }

  /** Legacy: closes the open day without a cash count. */
  @Roles(...MANAGEMENT)
  @HttpCode(200)
  @Post('close')
  close(@Body() dto: CloseDayDto, @CurrentUser() user: Principal) {
    return this.daybook.close({ businessDate: dto.businessDate }, user);
  }
}

@ApiTags('Day book')
@ApiBearerAuth()
@Controller('business-day')
export class BusinessDayController {
  constructor(private readonly daybook: DaybookService) {}

  @Roles(...DESK)
  @Get('current')
  current() {
    return this.daybook.current();
  }

  @Roles(...DESK)
  @HttpCode(200)
  @Post('start')
  start(@Body() dto: StartBusinessDayDto, @CurrentUser() user: Principal) {
    return this.daybook.start(dto, user);
  }

  @Roles(...MANAGEMENT)
  @HttpCode(200)
  @Post('close')
  close(@Body() dto: CloseBusinessDayDto, @CurrentUser() user: Principal) {
    return this.daybook.close(dto, user);
  }

  @Roles(Role.OWNER)
  @HttpCode(200)
  @Post('reopen')
  reopen(@Body() dto: ReopenBusinessDayDto, @CurrentUser() user: Principal) {
    return this.daybook.reopen(dto.businessDate, dto.note, user);
  }
}
