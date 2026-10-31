import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CurrentUser, Roles } from '../common/decorators';
import { DESK } from '../common/enums';
import { notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { oid } from '../common/pipes/parse-object-id.pipe';
import { BusinessDateService } from '../common/services/business-date.service';
import { DateOnlyQueryDto } from '../daybook/dto/daybook.dto';
import { Staff } from '../staff/schemas/staff.schema';
import { MarkAttendanceDto } from './dto/attendance.dto';
import { Attendance } from './schemas/attendance.schema';

@ApiTags('Back office')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('attendance')
export class AttendanceController {
  constructor(
    @InjectModel(Attendance.name) private readonly attendance: Model<Attendance>,
    @InjectModel(Staff.name) private readonly staff: Model<Staff>,
    private readonly dates: BusinessDateService,
  ) {}

  @Get()
  list(@Query() q: DateOnlyQueryDto) {
    return this.attendance.find({ businessDate: q.date }).lean();
  }

  @Put()
  async mark(@Body() dto: MarkAttendanceDto, @CurrentUser() user: Principal) {
    this.dates.assertAllowed(dto.businessDate, user);
    if (!(await this.staff.exists({ _id: dto.staffId }))) throw notFound('Staff member');
    return this.attendance.findOneAndUpdate(
      { staffId: oid(dto.staffId), businessDate: dto.businessDate },
      { $set: { mark: dto.mark, markedByUserId: userObjectId(user) } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }
}
