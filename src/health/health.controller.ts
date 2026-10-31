import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/decorators';
import { DatabaseHealthService } from '../database/database-health.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseHealthService) {}

  @Get()
  async check() {
    if (!(await this.db.ping())) throw new ServiceUnavailableException('database unreachable');
    return { status: 'ok', db: 'up' };
  }
}
