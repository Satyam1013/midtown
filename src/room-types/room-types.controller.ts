import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { AdminOnly, Roles } from '../common/decorators';
import { ALL_STAFF } from '../common/enums';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CreateRoomTypeDto, UpdateTariffDto } from './dto/room-type.dto';
import { RoomTypesService } from './room-types.service';

@ApiTags('Rooms')
@ApiBearerAuth()
@Controller('room-types')
export class RoomTypesController {
  constructor(private readonly types: RoomTypesService) {}

  @Roles(...ALL_STAFF)
  @Get()
  list() {
    return this.types.list();
  }

  @AdminOnly()
  @Patch(':id')
  updateTariff(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateTariffDto) {
    return this.types.updateTariff(id, dto);
  }

  @AdminOnly()
  @Post()
  create(@Body() dto: CreateRoomTypeDto) {
    return this.types.create(dto);
  }
}
