import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Roles } from '../common/decorators';
import { ALL_STAFF, MANAGEMENT } from '../common/enums';
import { badRequest } from '../common/errors';
import { toD128 } from '../common/utils/money';
import { normalizePhone } from '../common/utils/phone';
import { CreateStaffDto } from './staff.dto';
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

  @Roles(...MANAGEMENT)
  @Post()
  async create(@Body() dto: CreateStaffDto) {
    const phone = dto.phone ? normalizePhone(dto.phone) : '';
    if (dto.phone && phone.length !== 10) throw badRequest('INVALID_PHONE', 'Enter a 10-digit phone number');
    return this.staff.create({ name: dto.name.trim(), role: dto.role.trim(), shift: dto.shift.trim(), phone, salary: toD128(dto.salary) });
  }
}
