import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { Connection, Model, Types } from 'mongoose';
import { Role } from '../../common/enums';
import { toD128, toD128Exact } from '../../common/utils/money';
import { MenuItem } from '../../menu/schemas/menu-item.schema';
import { RoomType } from '../../room-types/schemas/room-type.schema';
import { Room, RoomStatus } from '../../rooms/schemas/room.schema';
import { Staff } from '../../staff/schemas/staff.schema';
import { StockItem } from '../../stock/schemas/stock-item.schema';
import { User } from '../../users/schemas/user.schema';
import { assertTransactionsSupported } from '../database-health.service';
import { TransactionService } from '../transaction.service';
import * as data from './seed-data';
import { SeedModule } from './seed.module';

// Idempotent: every document is upserted on its natural key with
// $setOnInsert, so re-running never duplicates anything and never
// overwrites data the hotel has since changed (prices, stock, password).

const log = new Logger('Seed');

async function main() {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn', 'log'] });
  try {
    const connection = app.get<Connection>(getConnectionToken());
    await assertTransactionsSupported(connection);

    // Build every index declared in the schemas before inserting.
    for (const name of connection.modelNames()) await connection.model(name).createIndexes();

    const model = <T>(cls: { name: string }) => app.get<Model<T>>(getModelToken(cls.name));
    const roomTypes = model<RoomType>(RoomType);
    const rooms = model<Room>(Room);
    const menu = model<MenuItem>(MenuItem);
    const staff = model<Staff>(Staff);
    const stock = model<StockItem>(StockItem);
    const users = model<User>(User);
    const config = app.get(ConfigService);

    const ownerPasswordHash = await bcrypt.hash(config.getOrThrow<string>('OWNER_PASSWORD'), 12);

    const counts = await app.get(TransactionService).run(async ({ session }) => {
      // timestamps: false, else Mongoose adds $set: { updatedAt } and every
      // re-run would touch every document.
      const now = new Date();
      const upsert = async <T>(m: Model<T>, filter: object, doc: object) => {
        const res = await m.updateOne(
          filter,
          { $setOnInsert: { ...doc, createdAt: now, updatedAt: now } },
          { upsert: true, session, timestamps: false },
        );
        return res.upsertedCount;
      };
      const c = { roomTypes: 0, rooms: 0, menuItems: 0, staff: 0, stockItems: 0, users: 0 };

      for (const t of data.roomTypes) {
        c.roomTypes += await upsert(roomTypes, { name: t.name }, {
          ...t,
          perks: [...t.perks],
          tariff: toD128(t.tariff),
          photoUrl: null,
        });
      }
      for (const t of data.categoryRoomTypes) {
        c.roomTypes += await upsert(roomTypes, { name: t.name }, {
          ...t,
          tariff: null,
          beds: '',
          size: '',
          sleeps: 4,
          blurb: '',
          perks: [],
          photoUrl: null,
        });
      }
      const typeByName = new Map<string, { _id: Types.ObjectId; tariff: Types.Decimal128 }>();
      for (const t of await roomTypes.find({ tariff: { $ne: null } }, { name: 1, tariff: 1 }).session(session).lean()) {
        typeByName.set(t.name, { _id: t._id, tariff: t.tariff! });
      }

      for (const r of data.rooms) {
        const type = typeByName.get(r.type);
        if (!type) throw new Error(`room ${r.number}: unknown room type ${r.type}`);
        c.rooms += await upsert(rooms, { number: r.number }, {
          number: r.number,
          floor: r.floor,
          roomTypeId: type._id,
          rate: type.tariff,
          singleRate: type.tariff,
          doubleRate: type.tariff,
          status: RoomStatus.VACANT,
        });
      }

      for (const m of data.menuItems) {
        c.menuItems += await upsert(menu, { name: m.name }, {
          ...m,
          price: toD128(m.price),
          photoUrl: null,
          available: true,
        });
      }

      for (const s of data.staff) {
        c.staff += await upsert(staff, { name: s.name }, { ...s, salary: toD128(s.salary) });
      }

      for (const s of data.stockItems) {
        c.stockItems += await upsert(stock, { item: s.item }, {
          ...s,
          qty: toD128Exact(s.qty),
          minQty: toD128Exact(s.minQty),
          rate: toD128(s.rate),
        });
      }

      c.users += await upsert(users, { phone: config.getOrThrow<string>('OWNER_PHONE') }, {
        name: config.getOrThrow<string>('OWNER_NAME'),
        phone: config.getOrThrow<string>('OWNER_PHONE'),
        email: config.get<string>('OWNER_EMAIL')?.toLowerCase() || null,
        passwordHash: ownerPasswordHash,
        role: Role.OWNER,
        active: true,
        tokenVersion: 0,
      });

      return c;
    });

    log.log(`inserted ${JSON.stringify(counts)} (0 = already present)`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
