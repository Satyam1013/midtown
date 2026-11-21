import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { CurrentUser } from '../common/decorators';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Expense } from '../expenses/schemas/expense.schema';
import { notFound } from '../common/errors';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { sum } from '../common/utils/money';
import { AdminOnly, Roles } from '../common/decorators';
import { ALL_STAFF, MANAGEMENT } from '../common/enums';
import { badRequest } from '../common/errors';
import { toD128 } from '../common/utils/money';

import { normalizePhone } from '../common/utils/phone';
import { CreateStaffDto, UpdateStaffDto } from './staff.dto';
import { Staff } from './schemas/staff.schema';

@ApiTags('Back office')
@ApiBearerAuth()
@Roles(...ALL_STAFF)
@Controller('staff')
export class StaffController {
  constructor(
    @InjectModel(Staff.name) private readonly staff: Model<Staff>,
    @InjectModel(Expense.name) private readonly expenses: Model<Expense>,
    private readonly audit: AuditService,
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
    // Past advances of deleted staff still resolve.
    const member = await this.staff.findById(id).setOptions({ withDeleted: true }).lean();
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

  /** ADMIN and MANAGER. Returns the member as GET /staff does. */
  @Roles(...MANAGEMENT)
  @Patch(':id')
  async update(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateStaffDto, @CurrentUser() user: Principal) {
    const member = await this.staff.findById(id);
    if (!member) throw notFound('Staff');
    const before = { name: member.name, role: member.role, shift: member.shift, phone: member.phone, salary: member.salary };
    if (dto.phone !== undefined) {
      const phone = dto.phone ? normalizePhone(dto.phone) : '';
      if (dto.phone && phone.length !== 10) throw badRequest('INVALID_PHONE', 'Enter a 10-digit phone number');
      member.phone = phone;
    }
    if (dto.name !== undefined) member.name = dto.name.trim();
    if (dto.role !== undefined) member.role = dto.role.trim();
    if (dto.shift !== undefined) member.shift = dto.shift.trim();
    if (dto.salary !== undefined) member.salary = toD128(dto.salary);
    await member.save();
    await this.audit.record(AuditAction.STAFF_UPDATE, null, userObjectId(user), { staffId: String(id), before, changes: dto }, null);
    return this.staff.findById(id).lean();
  }

  /** ADMIN only. 204; soft delete: attendance and advances stay. */
  @AdminOnly()
  @HttpCode(204)
  @Delete(':id')
  async remove(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @CurrentUser() user: Principal) {
    const member = await this.staff.findById(id);
    if (!member) throw notFound('Staff');
    member.set({ deletedAt: new Date(), deletedByUserId: userObjectId(user) });
    await member.save();
    await this.audit.record(AuditAction.STAFF_DELETE, null, userObjectId(user), { staffId: String(id), name: member.name, role: member.role, salary: member.salary }, null);
  }
}
