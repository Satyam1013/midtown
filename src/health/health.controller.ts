import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseHealthService } from '../database/database-health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseHealthService) {}

  @Get()
  async check() {
    if (!(await this.db.ping())) throw new ServiceUnavailableException('database unreachable');
    return { status: 'ok', db: 'up' };
  }
}
