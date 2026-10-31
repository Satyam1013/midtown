import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Roles } from '../common/decorators';
import { ALL_STAFF } from '../common/enums';
import { Staff } from './schemas/staff.schema';

@ApiTags('Back office')
@ApiBearerAuth()
@Roles(...ALL_STAFF)
@Controller('staff')
export class StaffController {
  constructor(@InjectModel(Staff.name) private readonly staff: Model<Staff>) {}

  // KITCHEN needs names to pick a waiter on a KOT, but not pay.
  @Get()
  list() {
    return this.staff.find().sort({ name: 1 }).lean();
  }
}
