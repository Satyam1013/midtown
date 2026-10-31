import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators';
import { ALL_STAFF } from '../common/enums';
import { MenuService } from './menu.service';

@ApiTags('Restaurant')
@ApiBearerAuth()
@Roles(...ALL_STAFF)
@Controller('menu')
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get()
  list() {
    return this.menu.list();
  }
}
