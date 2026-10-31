import { Controller, Get, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { Roles } from '../common/decorators';
import { PageQueryDto, pageOf } from '../common/dto/common.dto';
import { MANAGEMENT } from '../common/enums';
import { Paged } from '../common/interceptors/response.interceptor';
import { Feedback } from './schemas/feedback.schema';

@ApiTags('Back office')
@ApiBearerAuth()
@Roles(...MANAGEMENT)
@Controller('feedback')
export class FeedbackController {
  constructor(@InjectModel(Feedback.name) private readonly feedback: Model<Feedback>) {}

  @Get()
  async list(@Query() q: PageQueryDto) {
    const { page, limit, skip } = pageOf(q);
    const [items, total] = await Promise.all([
      this.feedback.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.feedback.countDocuments(),
    ]);
    return new Paged(items, { page, limit, total });
  }
}
