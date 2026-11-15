import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { dec, toD128 } from '../../common/utils/money';
import { DayRegisterEntry, EntrySource } from '../../entries/schemas/day-register-entry.schema';
import { FolioLine } from '../../folio/schemas/folio-line.schema';
import { Settlement } from '../../stays/schemas/settlement.schema';
import { Stay, StayStatus } from '../../stays/schemas/stay.schema';
import { assertTransactionsSupported } from '../database-health.service';
import { TransactionService } from '../transaction.service';
import { SeedModule } from './seed.module';

// One-off, idempotent: groups past check-outs into Settlements so old days
// show one register row per check-out, like new ones. Only grouping changes:
// no entry, cash line or amount is altered, so every total stays the same.
//  - the stay's CHECKOUT rows (including the old zero-amount "unpaid" row)
//  - its STAY_PAYMENT rows posted on that day in the 2 minutes before check-out
// Check-outs that posted no CHECKOUT row are left alone (nothing to merge).
const log = new Logger('Migrate');
const WINDOW_MS = 2 * 60_000;
const SYSTEM_TEXT = /^Settlement, room /;

async function main() {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn', 'log'] });
  try {
    await assertTransactionsSupported(app.get<Connection>(getConnectionToken()));
    const stays = app.get<Model<Stay>>(getModelToken(Stay.name));
    const entries = app.get<Model<DayRegisterEntry>>(getModelToken(DayRegisterEntry.name));
    const settlements = app.get<Model<Settlement>>(getModelToken(Settlement.name));
    const folio = app.get<Model<FolioLine>>(getModelToken(FolioLine.name));

    const result = await app.get(TransactionService).run(async ({ session }) => {
      let created = 0;
      let rowsGrouped = 0;
      const done = new Set((await settlements.find({}).select('stayId').session(session).lean()).map((s) => String(s.stayId)));
      for (const stay of await stays.find({ status: StayStatus.CHECKED_OUT }).session(session).lean()) {
        if (done.has(String(stay._id))) continue;
        const checkout = await entries.find({ stayId: stay._id, source: EntrySource.CHECKOUT, settlementId: null }).sort({ createdAt: 1 }).session(session).lean();
        if (!checkout.length) continue;
        const businessDate = checkout[0].businessDate;
        const end = stay.checkedOutAt ?? (checkout[checkout.length - 1] as any).createdAt;
        const before = await entries
          .find({
            stayId: stay._id,
            businessDate,
            source: EntrySource.STAY_PAYMENT,
            settlementId: null,
            createdAt: { $gte: new Date(+new Date(end) - WINDOW_MS), $lte: new Date(+new Date(end) + 5_000) },
          })
          .session(session)
          .lean();
        const owned = [...before, ...checkout];
        const paying = owned.filter((e) => dec(e.amount).gt(0));
        const [charges] = await folio
          .aggregate<{ total: any }>([
            { $match: { stayId: stay._id, deletedAt: null, source: { $nin: ['PAYMENT', 'REFUND', 'CREDIT'] } } },
            { $group: { _id: null, total: { $sum: '$amount' } } },
          ])
          .session(session);
        const shortfall = checkout.reduce((m, e) => (e.shortfall && dec(e.shortfall).gt(m) ? dec(e.shortfall) : m), dec(0));
        const typed = owned.map((e) => e.narration).find((n) => n && !SYSTEM_TEXT.test(n)) ?? '';
        const [s] = await settlements.create(
          [
            {
              stayId: stay._id,
              roomId: checkout[0].roomId ?? stay.roomId,
              customerId: stay.customerId ?? null,
              businessDate,
              time: checkout[checkout.length - 1].time,
              guestName: stay.guestName,
              phone: stay.phone,
              vehicle: stay.vehicle,
              narration: typed,
              billTotal: toD128(dec(charges?.total)),
              amount: toD128(paying.reduce((t, e) => t.plus(dec(e.amount)), dec(0))),
              payments: paying.map((e) => ({ entryId: e._id, mode: e.mode, amount: e.amount })),
              shortfall: shortfall.gt(0) ? toD128(shortfall) : null,
              createdByUserId: checkout[0].createdByUserId,
              migrated: true,
            },
          ],
          { session },
        );
        await entries.updateMany({ _id: { $in: owned.map((e) => e._id) } }, { $set: { settlementId: s._id } }, { session });
        created++;
        rowsGrouped += owned.length;
      }
      return { settlementsCreated: created, rowsGrouped };
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
