import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Expense } from '../expenses/schemas/expense.schema';
import { notFound } from '../common/errors';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { sum } from '../common/utils/money';
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
  constructor(
    @InjectModel(Staff.name) private readonly staff: Model<Staff>,
    @InjectModel(Expense.name) private readonly expenses: Model<Expense>,
  ) {}

  // KITCHEN needs names to pick a waiter on a KOT, but not pay.
  @Get()
  list() {
    return this.staff.find().sort({ name: 1 }).lean();
  }

  /** Salary advances paid to this staff member (expenses with their staffId), newest first, and the total. */
  @Roles(...MANAGEMENT)
  @Get(':id/advances')
  async advances(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    const member = await this.staff.findById(id).lean();
    if (!member) throw notFound('Staff');
    const items = await this.expenses.find({ staffId: id }).sort({ businessDate: -1, time: -1 }).lean();
    return {
      staffId: String(id),
      name: member.name,
      salary: member.salary,
      total: toD128(sum(items.map((x) => x.amount))),
      advances: items.map((x) => ({ id: x._id, businessDate: x.businessDate, time: x.time, amount: x.amount, mode: x.mode, head: x.head, narration: x.narration })),
    };
  }

  @Roles(...MANAGEMENT)
  @Post()
  async create(@Body() dto: CreateStaffDto) {
    const phone = dto.phone ? normalizePhone(dto.phone) : '';
    if (dto.phone && phone.length !== 10) throw badRequest('INVALID_PHONE', 'Enter a 10-digit phone number');
    return this.staff.create({ name: dto.name.trim(), role: dto.role.trim(), shift: dto.shift.trim(), phone, salary: toD128(dto.salary) });
  }
}
