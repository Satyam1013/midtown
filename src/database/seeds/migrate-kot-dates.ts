import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { SeedModule } from './seed.module';

// One-off, idempotent: KOTs placed before KOTs carried a businessDate get the
// hotel-timezone calendar date they were created on, so date-range reports count them.
const log = new Logger('Migrate');

async function main() {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn', 'log'] });
  try {
    const timezone = app.get(ConfigService).get<string>('HOTEL_TIMEZONE', 'Asia/Kolkata');
    const kots = app.get<Connection>(getConnectionToken()).collection('kots');
    const res = await kots.updateMany({ $or: [{ businessDate: null }, { businessDate: { $exists: false } }] }, [
      { $set: { businessDate: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone } } } },
    ]);
    log.log(`KOTs dated: ${res.modifiedCount}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
