import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../../config/env.validation';
import { DOMAIN_MODULES } from '../../domain-modules';
import { DatabaseModule } from '../database.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    DatabaseModule,
    ...DOMAIN_MODULES,
  ],
})
export class SeedModule {}
