import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { CurrentUser, Roles } from '../common/decorators';
import { DESK, Role } from '../common/enums';
import { badRequest, notFound, pastDateRestricted } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { oid } from '../common/pipes/parse-object-id.pipe';
import { BusinessDateService } from '../common/services/business-date.service';
import { TransactionService } from '../database/transaction.service';
import { DaybookService } from '../daybook/daybook.service';
import { Staff } from '../staff/schemas/staff.schema';
import { AttendanceQueryDto, BulkAttendanceDto, MarkAttendanceDto } from './dto/attendance.dto';
import { Attendance, AttendanceMark } from './schemas/attendance.schema';

const MAX_RANGE_DAYS = 366;

@ApiTags('Back office')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('attendance')
export class AttendanceController {
  constructor(
    @InjectModel(Attendance.name) private readonly attendance: Model<Attendance>,
    @InjectModel(Staff.name) private readonly staff: Model<Staff>,
    private readonly dates: BusinessDateService,
    private readonly daybook: DaybookService,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `?date=` or `?from=&to=` (at most 366 days), optionally `&staffId=`. Reading isn't
   * limited to the open day: the history calendar shows past months. Rows of deleted
   * staff are kept and returned.
   */
  @Get()
  list(@Query() q: AttendanceQueryDto) {
    const from = q.date ?? q.from;
    const to = q.date ?? q.to ?? q.from;
    if (!from || !to) throw badRequest('DATE_REQUIRED', 'Give a date, or from and to');
    if (!this.dates.isRealDate(from) || !this.dates.isRealDate(to)) throw badRequest('INVALID_DATE', 'Dates must be real YYYY-MM-DD dates');
    if (to < from) throw badRequest('INVALID_RANGE', '`from` must not be after `to`');
    if (this.dates.daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw badRequest('RANGE_TOO_LONG', `At most ${MAX_RANGE_DAYS} days at a time`);
    return this.attendance
      .find({ businessDate: from === to ? from : { $gte: from, $lte: to }, ...(q.staffId ? { staffId: oid(q.staffId) } : {}) })
      .sort({ businessDate: 1, staffId: 1 })
      .lean();
  }

  /** One mark per person per date; marking again replaces it. */
  @Put()
  async mark(@Body() dto: MarkAttendanceDto, @CurrentUser() user: Principal) {
    await this.assertMarkable(dto.businessDate, user);
    return this.tx.run(({ session }) => this.upsert(dto.staffId, dto.businessDate, dto.mark, user, session));
  }

  /** Several marks for one date ("mark all present"), all or none. */
  @HttpCode(200)
  @Post('bulk')
  async bulk(@Body() dto: BulkAttendanceDto, @CurrentUser() user: Principal) {
    await this.assertMarkable(dto.businessDate, user);
    if (new Set(dto.marks.map((m) => m.staffId)).size !== dto.marks.length) throw badRequest('DUPLICATE_STAFF', 'Each staff member once');
    return this.tx.run(async ({ session }) => {
      const rows = [];
      for (const m of dto.marks) rows.push(await this.upsert(m.staffId, dto.businessDate, m.mark, user, session));
      return rows;
    });
  }

  /** Never a future date. ADMIN: any past date. Others: only the open business day (403). */
  private async assertMarkable(date: string, user: Principal) {
    if (!this.dates.isRealDate(date)) throw badRequest('INVALID_DATE', 'businessDate must be a real date');
    const open = await this.daybook.openDate();
    const latest = [this.dates.today(), open ?? ''].sort().pop()!;
    if (date > latest) throw badRequest('FUTURE_DATE', 'Attendance can’t be marked for a future date');
    if (user.role !== Role.ADMIN && date !== open) throw pastDateRestricted();
  }

  private async upsert(staffId: string, businessDate: string, mark: AttendanceMark, user: Principal, session: ClientSession) {
    if (!(await this.staff.exists({ _id: staffId }).session(session))) throw notFound('Staff member');
    const before = await this.attendance.findOne({ staffId: oid(staffId), businessDate }).session(session).lean();
    const row = await this.attendance.findOneAndUpdate(
      { staffId: oid(staffId), businessDate },
      { $set: { mark, markedByUserId: userObjectId(user) } },
      { upsert: true, new: true, setDefaultsOnInsert: true, session },
    );
    if (before?.mark !== mark) {
      await this.audit.record(AuditAction.ATTENDANCE_MARK, null, userObjectId(user), { staffId, from: before?.mark ?? null, to: mark }, session, businessDate);
    }
    return row;
  }
}

