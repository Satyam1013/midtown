import { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import { Connection, Model } from 'mongoose';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { Role } from '../src/common/enums';
import { BusinessDateService } from '../src/common/services/business-date.service';
import { toD128, toD128Exact } from '../src/common/utils/money';
import { configureApp } from '../src/configure-app';
import * as data from '../src/database/seeds/seed-data';

export const PASSWORD = 'password-for-tests';

export interface Ctx {
  app: INestApplication;
  api: () => ReturnType<typeof request>;
  model: <T = any>(name: string) => Model<T>;
  token: Record<'OWNER' | 'MANAGER' | 'STAFF' | 'KITCHEN', string>;
  today: string;
  roomId: (number: string) => Promise<string>;
  menuId: (name: string) => Promise<string>;
}

export async function bootApp(): Promise<Ctx> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();

  const connection = app.get<Connection>(getConnectionToken());
  if (!connection.name.endsWith('_test')) throw new Error(`Refusing to wipe database ${connection.name}`);
  await connection.dropDatabase();
  for (const name of connection.modelNames()) await connection.model(name).createIndexes();

  const model = <T = any>(name: string) => app.get<Model<T>>(getModelToken(name));
  const types = await model('RoomType').insertMany(
    data.roomTypes.map((t) => ({ ...t, perks: [...t.perks], tariff: toD128(t.tariff) })),
  );
  await model('RoomType').insertMany(
    data.categoryRoomTypes.map((t) => ({ ...t, tariff: null, beds: '', size: '', sleeps: 4, blurb: '', perks: [] })),
  );
  await model('Room').insertMany(
    data.rooms.map((r) => {
      const type = types.find((t: any) => t.name === r.type) as any;
      return { number: r.number, floor: r.floor, roomTypeId: type._id, rate: type.tariff };
    }),
  );
  await model('MenuItem').insertMany(data.menuItems.map((m) => ({ ...m, price: toD128(m.price) })));
  await model('Staff').insertMany(data.staff.map((s) => ({ ...s, salary: toD128(s.salary) })));
  await model('StockItem').insertMany(
    data.stockItems.map((s) => ({ ...s, qty: toD128Exact(s.qty), minQty: toD128Exact(s.minQty), rate: toD128(s.rate) })),
  );

  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const api = () => request(app.getHttpServer());
  const token = {} as Ctx['token'];
  let phone = 9100000000;
  for (const role of ['OWNER', 'MANAGER', 'STAFF', 'KITCHEN'] as const) {
    const number = String(phone++);
    await model('User').create({ name: role, phone: number, passwordHash, role: Role[role] });
    const res = await api().post('/api/v1/auth/staff/login').send({ identifier: number, password: PASSWORD }).expect(200);
    token[role] = res.body.accessToken;
  }

  return {
    app,
    api,
    model,
    token,
    today: app.get(BusinessDateService).today(),
    roomId: async (number) => String((await model('Room').findOne({ number }).lean() as any)._id),
    menuId: async (name) => String((await model('MenuItem').findOne({ name }).lean() as any)._id),
  };
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

export async function checkIn(ctx: Ctx, number: string, guestName: string, phone: string) {
  const res = await ctx
    .api()
    .post('/api/v1/stays')
    .set(bearer(ctx.token.STAFF))
    .send({ roomId: await ctx.roomId(number), guestName, phone, nights: 2 })
    .expect(201);
  return res.body.data.stay;
}
