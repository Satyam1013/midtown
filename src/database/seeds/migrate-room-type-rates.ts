import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import Decimal from 'decimal.js';
import { dec, toD128 } from '../../common/utils/money';
import { RoomType } from '../../room-types/schemas/room-type.schema';
import { Room } from '../../rooms/schemas/room.schema';
import { assertTransactionsSupported } from '../database-health.service';
import { TransactionService } from '../transaction.service';
import { SeedModule } from './seed.module';

// One-off, idempotent: gives every room type occupancy prices.
//   singleRate = tariff, else the cheapest room's single rate
//   doubleRate = the cheapest room's double rate (never below single), else single
//   additionalGuestRate = 0; tariff = singleRate
// Types with no tariff and no rooms are listed and left for the owner to price.
const log = new Logger('Migrate');

async function main() {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn', 'log'] });
  try {
    await assertTransactionsSupported(app.get<Connection>(getConnectionToken()));
    const types = app.get<Model<RoomType>>(getModelToken(RoomType.name));
    const rooms = app.get<Model<Room>>(getModelToken(Room.name));
    const result = await app.get(TransactionService).run(async ({ session }) => {
      const updated: string[] = [];
      const unpriced: string[] = [];
      for (const t of await types.find({ $or: [{ singleRate: null }, { singleRate: { $exists: false } }] }).session(session)) {
        const own = await rooms.find({ roomTypeId: t._id }).session(session).lean();
        const min = (vals: (Types.Decimal128 | null | undefined)[]) =>
          vals.filter(Boolean).map((v) => dec(v)).reduce<Decimal | null>((m, v) => (m === null || v.lt(m) ? v : m), null);
        const single = t.tariff ? dec(t.tariff) : min(own.map((r) => r.singleRate ?? r.rate));
        if (!single) {
          unpriced.push(t.name);
          continue;
        }
        const double = min(own.map((r) => r.doubleRate ?? r.rate)) ?? single;
        t.singleRate = toD128(single);
        t.doubleRate = toD128(Decimal.max(single, double));
        t.additionalGuestRate ??= toD128('0');
        t.tariff = t.singleRate;
        await t.save({ session });
        updated.push(`${t.name}: ${single.toFixed(2)} / ${Decimal.max(single, double).toFixed(2)}`);
      }
      return { updated, unpriced };
    });
    log.log(`done ${JSON.stringify(result)}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
