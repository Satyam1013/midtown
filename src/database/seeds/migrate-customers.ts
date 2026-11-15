import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { dec, toD128 } from '../../common/utils/money';
import { customerPhone } from '../../customers/customers.service';
import { Customer } from '../../customers/schemas/customer.schema';
import { FolioLine } from '../../folio/schemas/folio-line.schema';
import { Stay, StayStatus } from '../../stays/schemas/stay.schema';
import { assertTransactionsSupported } from '../database-health.service';
import { TransactionService } from '../transaction.service';
import { SeedModule } from './seed.module';

// One-off, idempotent: builds customers from stays that have none.
//  - stays are grouped by phone (last 10 digits); the latest stay's name wins
//  - a stay with no usable phone gets a customer of its own
//  - visits, first/last visit and money spent on checked-out stays are filled in
// A phone that already has a customer (from a check-in since the deploy) is
// added to that customer rather than duplicated.
const log = new Logger('Migrate');

async function main() {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn', 'log'] });
  try {
    await assertTransactionsSupported(app.get<Connection>(getConnectionToken()));
    const stays = app.get<Model<Stay>>(getModelToken(Stay.name));
    const customers = app.get<Model<Customer>>(getModelToken(Customer.name));
    const folio = app.get<Model<FolioLine>>(getModelToken(FolioLine.name));

    const result = await app.get(TransactionService).run(async ({ session }) => {
      const pending = await stays.find({ $or: [{ customerId: null }, { customerId: { $exists: false } }] }).sort({ createdAt: 1 }).session(session).lean();
      const spentRows = await folio.aggregate<{ _id: Types.ObjectId; total: Types.Decimal128 }>([
        { $match: { stayId: { $in: pending.map((s) => s._id) }, deletedAt: null, source: { $nin: ['PAYMENT', 'REFUND'] } } },
        { $group: { _id: '$stayId', total: { $sum: '$amount' } } },
      ]).session(session);
      const spentOf = new Map(spentRows.map((r) => [String(r._id), dec(r.total)]));

      const groups = new Map<string, typeof pending>();
      for (const s of pending) {
        const key = customerPhone(s.phone) ?? `nophone:${s._id}`;
        groups.set(key, [...(groups.get(key) ?? []), s]);
      }
      let created = 0;
      for (const [key, group] of groups) {
        const phone = key.startsWith('nophone:') ? null : key;
        const latest = group[group.length - 1];
        const at = (s: any) => s.createdAt ?? new Date(`${s.checkIn}T12:00:00Z`);
        const spent = group
          .filter((s) => s.status === StayStatus.CHECKED_OUT)
          .reduce((n, s) => n.plus(spentOf.get(String(s._id)) ?? 0), dec(0));
        const existing = phone ? await customers.findOne({ phone }).session(session) : null;
        let customerId: Types.ObjectId;
        if (existing) {
          existing.visits += group.length;
          existing.totalSpent = toD128(dec(existing.totalSpent).plus(spent));
          if (!existing.firstVisitAt || at(group[0]) < existing.firstVisitAt) existing.firstVisitAt = at(group[0]);
          if (!existing.lastVisitAt || at(latest) > existing.lastVisitAt) existing.lastVisitAt = at(latest);
          if (!existing.name) existing.name = latest.guestName;
          await existing.save({ session });
          customerId = existing._id;
        } else {
          const [c] = await customers.create(
            [{ name: latest.guestName, phone, visits: group.length, totalSpent: toD128(spent), firstVisitAt: at(group[0]), lastVisitAt: at(latest) }],
            { session },
          );
          customerId = c._id;
          created++;
        }
        await stays.updateMany({ _id: { $in: group.map((s) => s._id) } }, { $set: { customerId } }, { session });
      }
      return { staysLinked: pending.length, customersCreated: created };
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
