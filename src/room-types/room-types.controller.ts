import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { Roles } from '../common/decorators';
import { ALL_STAFF, Role } from '../common/enums';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { UpdateTariffDto } from './dto/room-type.dto';
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

  @Roles(Role.OWNER)
  @Patch(':id')
  updateTariff(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateTariffDto) {
    return this.types.updateTariff(id, dto.tariff);
  }
}
