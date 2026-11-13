import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { Roles } from '../common/decorators';
import { ALL_STAFF, DESK, MANAGEMENT } from '../common/enums';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CreateRoomDto, SetRoomStatusDto, UpdateRoomDto } from './dto/room.dto';
import { RoomsService } from './rooms.service';

@ApiTags('Rooms')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Roles(...ALL_STAFF)
  @Get()
  list() {
    return this.rooms.list();
  }

  @Roles(...MANAGEMENT)
  @Post()
  create(@Body() dto: CreateRoomDto) {
    return this.rooms.create(dto);
  }

  @HttpCode(200)
  @Post('mark-all-clean')
  markAllClean() {
    return this.rooms.markAllClean();
  }

  /** Category, type and prices; stays already in progress keep their rate. */
  @Roles(...MANAGEMENT)
  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateRoomDto) {
    return this.rooms.update(id, dto);
  }

  @Patch(':id/status')
  setStatus(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: SetRoomStatusDto) {
    return this.rooms.setStatus(id, dto.status);
  }
}
