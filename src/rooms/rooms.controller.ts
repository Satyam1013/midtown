import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadedFileLike } from '../customers/customer-documents.service';
import { MAX_IMAGE_BYTES } from '../files/image-storage.service';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { CurrentUser, Roles } from '../common/decorators';
import { Principal } from '../common/interfaces/principal';
import { ALL_STAFF, DESK, MANAGEMENT } from '../common/enums';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CreateRoomDto, MaintenanceHistoryQueryDto, SetRoomStatusDto, UpdateRoomDto } from './dto/room.dto';
import { RoomsService } from './rooms.service';

@ApiTags('Rooms')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Roles(...MANAGEMENT)
  @Get('maintenance-history')
  maintenanceHistory(@Query() q: MaintenanceHistoryQueryDto) {
    return this.rooms.maintenanceHistory(q.roomId);
  }

  @Roles(...ALL_STAFF)
  @Get()
  list() {
    return this.rooms.list();
  }

  @Roles(...ALL_STAFF)
  @Get(':id')
  one(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.rooms.one(id);
  }

  /** One photo per call (multipart, field "file"): JPG, PNG or WEBP, up to 5 MB. */
  @Roles(...MANAGEMENT)
  @ApiConsumes('multipart/form-data')
  @Post(':id/images')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  addImage(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @UploadedFile() file: UploadedFileLike | undefined) {
    return this.rooms.addImage(id, file);
  }

  @Roles(...MANAGEMENT)
  @Delete(':id/images/:imageId')
  removeImage(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Param('imageId', ParseObjectIdPipe) imageId: Types.ObjectId) {
    return this.rooms.removeImage(id, imageId);
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
  update(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateRoomDto, @CurrentUser() user: Principal) {
    return this.rooms.update(id, dto, user);
  }

  @Patch(':id/status')
  setStatus(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: SetRoomStatusDto, @CurrentUser() user: Principal) {
    return this.rooms.setStatus(id, dto, user);
  }
}
