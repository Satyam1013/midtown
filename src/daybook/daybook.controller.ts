import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../common/decorators';
import { DESK, MANAGEMENT } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { DaybookService } from './daybook.service';
import { CloseDayDto, DateOnlyQueryDto, SetOpeningDto } from './dto/daybook.dto';

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

  @Roles(...MANAGEMENT)
  @Patch('opening')
  setOpening(@Body() dto: SetOpeningDto, @CurrentUser() user: Principal) {
    return this.daybook.setOpening(dto.businessDate, dto.openingBalance, user);
  }

  @Roles(...MANAGEMENT)
  @HttpCode(200)
  @Post('close')
  close(@Body() dto: CloseDayDto, @CurrentUser() user: Principal) {
    return this.daybook.close(dto.businessDate, user);
  }
}
