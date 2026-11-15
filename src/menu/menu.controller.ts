import { Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { Roles } from '../common/decorators';
import { ALL_STAFF, MANAGEMENT } from '../common/enums';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { UploadedFileLike } from '../customers/customer-documents.service';
import { MAX_IMAGE_BYTES } from '../files/image-storage.service';
import { CreateMenuItemDto } from './dto/menu.dto';
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

  @Roles(...MANAGEMENT)
  @Post()
  create(@Body() dto: CreateMenuItemDto) {
    return this.menu.create(dto);
  }

  /** Multipart, field "file": JPG, PNG or WEBP, up to 5 MB. Sets photoUrl. */
  @Roles(...MANAGEMENT)
  @ApiConsumes('multipart/form-data')
  @Post(':id/photo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  photo(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @UploadedFile() file: UploadedFileLike | undefined) {
    return this.menu.setPhoto(id, file);
  }
}
