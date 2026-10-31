import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { CurrentUser, Roles } from '../common/decorators';
import { DESK, MANAGEMENT } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { DateOnlyQueryDto } from '../daybook/dto/daybook.dto';
import { CreateEntryDto, UpdateEntryDto } from './dto/entry.dto';
import { EntriesService } from './entries.service';

@ApiTags('Day book')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('entries')
export class EntriesController {
  constructor(private readonly entries: EntriesService) {}

  @Get()
  list(@Query() q: DateOnlyQueryDto) {
    return this.entries.list(q.date);
  }

  @Post()
  create(@Body() dto: CreateEntryDto, @CurrentUser() user: Principal) {
    return this.entries.create(dto, user);
  }

  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateEntryDto, @CurrentUser() user: Principal) {
    return this.entries.update(id, dto, user);
  }

  @Roles(...MANAGEMENT)
  @Delete(':id')
  remove(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @CurrentUser() user: Principal) {
    return this.entries.remove(id, user);
  }
}
