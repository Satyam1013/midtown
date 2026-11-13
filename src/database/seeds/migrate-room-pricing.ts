import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { Room } from '../../rooms/schemas/room.schema';
import { FolioLine, FolioSource } from '../../folio/schemas/folio-line.schema';
import { Stay, StayStatus } from '../../stays/schemas/stay.schema';
import { assertTransactionsSupported } from '../database-health.service';
import { TransactionService } from '../transaction.service';
import { SeedModule } from './seed.module';

// One-off, idempotent migration for per-guest pricing:
//  - rooms without single/double rates get both set to their current `rate`
//    (no automatic +300 on the double; the manager sets real prices later)
//  - in-house stays without room-charge segments get one, built from the stay
//    and its existing TARIFF folio line, with guests = 1
// The app works without it (it falls back the same way); this makes it explicit.
const log = new Logger('Migrate');

async function main() {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn', 'log'] });
  try {
    await assertTransactionsSupported(app.get<Connection>(getConnectionToken()));
    const rooms = app.get<Model<Room>>(getModelToken(Room.name));
    const stays = app.get<Model<Stay>>(getModelToken(Stay.name));
    const folio = app.get<Model<FolioLine>>(getModelToken(FolioLine.name));

    const result = await app.get(TransactionService).run(async ({ session }) => {
      const roomRes = await rooms.updateMany(
        { $or: [{ singleRate: null }, { doubleRate: null }] },
        [{ $set: { singleRate: { $ifNull: ['$singleRate', '$rate'] }, doubleRate: { $ifNull: ['$doubleRate', '$rate'] } } }],
        { session },
      );
      let staysUpdated = 0;
      const legacy = await stays
        .find({ status: StayStatus.IN_HOUSE, $or: [{ roomCharges: { $size: 0 } }, { roomCharges: { $exists: false } }] })
        .session(session);
      for (const stay of legacy) {
        const room = await rooms.findById(stay.roomId).select('number').session(session).lean();
        const line = await folio.findOne({ stayId: stay._id, source: FolioSource.TARIFF }).session(session).lean();
        stay.guests = stay.guests ?? 1;
        stay.roomCharges = [
          {
            label: `Room ${room?.number ?? ''}`,
            roomId: stay.roomId,
            roomNumber: room?.number ?? '',
            guests: stay.guests,
            rate: stay.rate,
            nights: stay.nights,
            folioLineId: line?._id ?? null,
          },
        ] as any;
        await stay.save({ session });
        staysUpdated++;
      }
      return { roomsUpdated: roomRes.modifiedCount, staysUpdated };
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
