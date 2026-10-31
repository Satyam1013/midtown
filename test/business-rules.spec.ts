import { io, Socket } from 'socket.io-client';
import { AddressInfo } from 'net';
import { ConfigService } from '@nestjs/config';
import { SmsService } from '../src/auth/sms.service';
import { bearer, bootApp, checkIn, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;
let lastOtp = '';

beforeAll(async () => {
  ctx = await bootApp();
  jest.spyOn(ctx.app.get(SmsService), 'sendOtp').mockImplementation(async (_phone, otp) => {
    lastOtp = otp;
  });
});

afterAll(async () => {
  await ctx.app.close();
});

const staff = () => bearer(ctx.token.STAFF);

const newEntry = async (over: Record<string, unknown> = {}) => ({
  businessDate: ctx.today,
  time: '10:00',
  roomId: await ctx.roomId('101'),
  guestName: 'Ravi Kumar',
  phone: '9876543210',
  vehicle: '',
  type: 'Other receipt',
  mode: 'CASH',
  dc: 'CREDIT',
  amount: '1000.00',
  narration: 'test',
  ...over,
});

async function guestLogin(room: string, phone: string) {
  await ctx.model('OtpChallenge').deleteMany({}); // resend cooldown
  await ctx.api().post(`${V1}/auth/guest/request-otp`).send({ roomNumber: room, phone }).expect(200);
  const res = await ctx.api().post(`${V1}/auth/guest/verify-otp`).send({ roomNumber: room, phone, otp: lastOtp }).expect(200);
  return res.body.data.accessToken as string;
}

const liveCash = (entryId: string) => ctx.model('CashTxn').find({ entryId }).lean();

describe('Rule 1: no double entries', () => {
  it('1. rejects a duplicate entry with 409 and the existing id', async () => {
    const body = await newEntry({ amount: '1500.00' });
    const first = await ctx.api().post(`${V1}/entries`).set(staff()).send(body).expect(201);
    const dup = await ctx.api().post(`${V1}/entries`).set(staff()).send({ ...body, guestName: 'RAVI KUMAR' }).expect(409);
    expect(dup.body).toMatchObject({ statusCode: 409, code: 'DUPLICATE_ENTRY', entryId: first.body.data.id });
    expect(await ctx.model('DayRegisterEntry').countDocuments({ amount: '1500.00' })).toBe(1);
  });

  it('simultaneous identical entries create only one', async () => {
    const body = await newEntry({ amount: '1234.00' });
    const results = await Promise.all([1, 2, 3].map(() => ctx.api().post(`${V1}/entries`).set(staff()).send(body)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await ctx.model('CashTxn').countDocuments({ amount: '1234.00' })).toBe(1);
  });

  it('2 and 3. editing rewrites the existing CashTxn and never adds a second', async () => {
    const created = await ctx.api().post(`${V1}/entries`).set(staff()).send(await newEntry({ amount: '700.00' })).expect(201);
    const id = created.body.data.id;
    const [before] = await liveCash(id);
    await ctx.api().patch(`${V1}/entries/${id}`).set(staff()).send({ amount: '750.00', mode: 'UPI' }).expect(200);
    const after = await liveCash(id);
    expect(after).toHaveLength(1);
    expect(String(after[0]._id)).toBe(String(before._id));
    expect(after[0].amount.toString()).toBe('750.00');
    expect(after[0].mode).toBe('UPI');
  });

  it('amount to zero removes the cash line; zero to positive creates one', async () => {
    const created = await ctx.api().post(`${V1}/entries`).set(staff()).send(await newEntry({ amount: '0' , guestName: 'Zero Guest' })).expect(201);
    const id = created.body.data.id;
    expect(await liveCash(id)).toHaveLength(0);
    await ctx.api().patch(`${V1}/entries/${id}`).set(staff()).send({ amount: '300.00' }).expect(200);
    expect(await liveCash(id)).toHaveLength(1);
    const zeroed = await ctx.api().patch(`${V1}/entries/${id}`).set(staff()).send({ amount: '0' }).expect(200);
    expect(await liveCash(id)).toHaveLength(0);
    expect(zeroed.body.data.txnId).toBeNull();
  });

  it('4. a refund posts exactly one DEBIT entry, cash line and folio line', async () => {
    const stay = await checkIn(ctx, '102', 'Refund Guest', '9811111111');
    await ctx.api().patch(`${V1}/stays/${stay.id}`).set(staff())
      .send({ payment: { kind: 'REFUND', amount: '500.00', mode: 'CASH', businessDate: ctx.today, time: '11:00', narration: 'Refund' } })
      .expect(200);
    const entries = await ctx.model('DayRegisterEntry').find({ stayId: stay.id }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0].dc).toBe('DEBIT');
    const cash = await liveCash(String(entries[0]._id));
    expect(cash).toHaveLength(1);
    expect(cash[0].dc).toBe('DEBIT');
    const folio = await ctx.model('FolioLine').find({ stayId: stay.id, source: 'REFUND' }).lean();
    expect(folio).toHaveLength(1);
    expect(folio[0].amount.toString()).toBe('500.00');
  });

  it('14. soft-deleted entries leave normal queries and the cash book', async () => {
    const created = await ctx.api().post(`${V1}/entries`).set(staff()).send(await newEntry({ amount: '333.00' })).expect(201);
    const id = created.body.data.id;
    await ctx.api().delete(`${V1}/entries/${id}`).set(staff()).expect(403); // STAFF can't delete
    await ctx.api().delete(`${V1}/entries/${id}`).set(bearer(ctx.token.MANAGER)).expect(200);
    const list = await ctx.api().get(`${V1}/entries`).query({ date: ctx.today }).set(staff()).expect(200);
    expect(list.body.data.map((e: any) => e.id)).not.toContain(id);
    expect(await liveCash(id)).toHaveLength(0);
    expect(await ctx.model('DayRegisterEntry').countDocuments({ _id: id }).setOptions({ withDeleted: true })).toBe(1);
  });
});

describe('Rule 2: atomic financial writes', () => {
  it('16. a failure on the last write rolls everything back and emits nothing', async () => {
    const stay = await checkIn(ctx, '103', 'Rollback Guest', '9822222222');
    const folioModel = ctx.model('FolioLine');
    const entriesBefore = await ctx.model('DayRegisterEntry').countDocuments();
    const cashBefore = await ctx.model('CashTxn').countDocuments();
    const spy = jest.spyOn(folioModel, 'create').mockRejectedValueOnce(new Error('disk full') as never);
    const emit = jest.spyOn((await import('../src/notifications/events.service')).EventsService.prototype, 'toHotel');
    await ctx.api().patch(`${V1}/stays/${stay.id}`).set(staff())
      .send({ guestName: 'Renamed', payment: { kind: 'ADVANCE', amount: '900.00', mode: 'CASH', businessDate: ctx.today, time: '12:00' } })
      .expect(500);
    spy.mockRestore();
    expect(await ctx.model('DayRegisterEntry').countDocuments()).toBe(entriesBefore);
    expect(await ctx.model('CashTxn').countDocuments()).toBe(cashBefore);
    expect(((await ctx.model('Stay').findById(stay.id).lean()) as any).guestName).toBe('Rollback Guest');
    expect(emit).not.toHaveBeenCalled();
    emit.mockRestore();
  });
});

describe('Rule 3: day book', () => {
  // A past date, so these tests don't close the day the others post to.
  const dayOffset = (n: number) => {
    const d = new Date(`${ctx.today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  it('5. closing = opening + credits - debits, and carries to the next day', async () => {
    const date = dayOffset(-3);
    const manager = bearer(ctx.token.MANAGER);
    await ctx.api().patch(`${V1}/daybook/opening`).set(manager).send({ businessDate: date, openingBalance: '1000.10' }).expect(200);
    const post = async (amount: string, dc: string, guestName: string) =>
      ctx.api().post(`${V1}/entries`).set(staff()).send(await newEntry({ businessDate: date, amount, dc, guestName })).expect(201);
    await post('250.20', 'CREDIT', 'A');
    await post('0.10', 'CREDIT', 'B');
    await post('100.05', 'DEBIT', 'C');
    await ctx.api().post(`${V1}/expenses`).set(staff()).send({ businessDate: date, head: 'Laundry', mode: 'CASH', amount: '50.00' }).expect(201);

    const closed = await ctx.api().post(`${V1}/daybook/close`).set(manager).send({ businessDate: date }).expect(200);
    expect(closed.body.data.closingBalance).toBe(1100.35); // 1000.10 + 250.30 - 150.05
    expect(closed.body.data.closedByUserId).toBeTruthy();

    const next = await ctx.api().get(`${V1}/daybook`).query({ date: dayOffset(-2) }).set(staff()).expect(200);
    expect(next.body.data.openingBalance).toBe(1100.35);
  });

  it('STAFF cannot close the day', async () => {
    await ctx.api().post(`${V1}/daybook/close`).set(staff()).send({ businessDate: dayOffset(-4) }).expect(403);
  });

  it('6. a closed date rejects STAFF and MANAGER', async () => {
    const date = dayOffset(-5);
    await ctx.api().post(`${V1}/daybook/close`).set(bearer(ctx.token.MANAGER)).send({ businessDate: date }).expect(200);
    for (const token of [ctx.token.STAFF, ctx.token.MANAGER]) {
      const res = await ctx.api().post(`${V1}/entries`).set(bearer(token)).send(await newEntry({ businessDate: date })).expect(409);
      expect(res.body.code).toBe('DAY_CLOSED');
    }
  });

  it('7. OWNER can still post to a closed date', async () => {
    await ctx.api().post(`${V1}/entries`).set(bearer(ctx.token.OWNER)).send(await newEntry({ businessDate: dayOffset(-5) })).expect(201);
  });

  it('business date limits: future and over 7 days old are rejected, OWNER may override', async () => {
    const future = await newEntry({ businessDate: dayOffset(1), guestName: 'Future' });
    const old = await newEntry({ businessDate: dayOffset(-8), guestName: 'Old' });
    expect((await ctx.api().post(`${V1}/entries`).set(staff()).send(future).expect(400)).body.code).toBe('FUTURE_DATE');
    expect((await ctx.api().post(`${V1}/entries`).set(staff()).send(old).expect(400)).body.code).toBe('DATE_TOO_OLD');
    await ctx.api().post(`${V1}/entries`).set(bearer(ctx.token.OWNER)).send(old).expect(201);
  });
});

describe('Rule 4: room status', () => {
  it('12. check-in rejects occupied and dirty rooms', async () => {
    await checkIn(ctx, '104', 'First Guest', '9833333333');
    const body = { roomId: await ctx.roomId('104'), guestName: 'Second', phone: '9844444444', nights: 1 };
    expect((await ctx.api().post(`${V1}/stays`).set(staff()).send(body).expect(409)).body.code).toBe('ROOM_NOT_VACANT');

    const roomId = await ctx.roomId('105');
    const stay = await checkIn(ctx, '105', 'Leaving', '9855555555');
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200);
    await ctx.api().post(`${V1}/stays`).set(staff()).send({ ...body, roomId }).expect(409);
  });

  it('13. check-out makes the room DIRTY, housekeeping makes it VACANT', async () => {
    const roomId = await ctx.roomId('106');
    const stay = await checkIn(ctx, '106', 'Out Guest', '9866666666');
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200);
    expect(((await ctx.model('Room').findById(roomId).lean()) as any).status).toBe('DIRTY');
    await ctx.api().patch(`${V1}/rooms/${roomId}/status`).set(staff()).send({ status: 'VACANT' }).expect(200);
  });

  it('manual status is limited to OOO and housekeeping', async () => {
    const roomId = await ctx.roomId('201');
    const manual = await ctx.api().patch(`${V1}/rooms/${roomId}/status`).set(staff()).send({ status: 'OCCUPIED' }).expect(409);
    expect(manual.body.code).toBe('MANUAL_STATUS_NOT_ALLOWED');
    await ctx.api().patch(`${V1}/rooms/${roomId}/status`).set(staff()).send({ status: 'OOO' }).expect(200);
    await ctx.api().patch(`${V1}/rooms/${roomId}/status`).set(staff()).send({ status: 'VACANT' }).expect(200);
  });

  it('15. concurrent check-ins cannot occupy the same room', async () => {
    const roomId = await ctx.roomId('202');
    const attempt = (n: number) =>
      ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId, guestName: `Racer ${n}`, phone: `98770000${n}0`, nights: 1 });
    const results = await Promise.all([1, 2, 3, 4].map(attempt));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(await ctx.model('Stay').countDocuments({ roomId, status: 'IN_HOUSE' })).toBe(1);
  });
});

describe('Guest security and orders', () => {
  let guestA: string;
  let guestB: string;
  let stayA: any;
  let stayB: any;

  beforeAll(async () => {
    stayA = await checkIn(ctx, '203', 'Guest A', '9700000001');
    stayB = await checkIn(ctx, '204', 'Guest B', '9700000002');
    guestA = await guestLogin('203', '9700000001');
    guestB = await guestLogin('204', '9700000002');
  });

  it('wrong phone gets no OTP; an OTP works only once', async () => {
    await ctx.api().post(`${V1}/auth/guest/request-otp`).send({ roomNumber: '203', phone: '9000000099' }).expect(404);
    await guestLogin('203', '9700000001');
    await ctx.api().post(`${V1}/auth/guest/verify-otp`).send({ roomNumber: '203', phone: '9700000001', otp: lastOtp }).expect(401);
  });

  it('bypass mode skips the SMS but still needs a matching room and phone', async () => {
    const config = ctx.app.get(ConfigService);
    const realGet = config.get.bind(config);
    const spy = jest.spyOn(config, 'get').mockImplementation(((key: string, fallback?: unknown) =>
      key === 'OTP_PROVIDER' ? 'bypass' : realGet(key, fallback)) as any);
    const send = ctx.app.get(SmsService).sendOtp as jest.Mock;
    send.mockClear();
    const creds = { roomNumber: '203', phone: '9700000001' };
    await ctx.api().post(`${V1}/auth/guest/request-otp`).send(creds).expect(200);
    expect(send).not.toHaveBeenCalled();
    const res = await ctx.api().post(`${V1}/auth/guest/verify-otp`).send({ ...creds, otp: '000000' }).expect(200);
    const stay = await ctx.api().get(`${V1}/guest/stay`).set(bearer(res.body.data.accessToken)).expect(200);
    expect(stay.body.data.stay.id).toBe(stayA.id);
    await ctx.api().post(`${V1}/auth/guest/verify-otp`).send({ ...creds, phone: '9000000099', otp: '000000' }).expect(404);
    await ctx.api().post(`${V1}/auth/guest/verify-otp`).send({ ...creds, otp: '12' }).expect(400);
    spy.mockRestore();
  });

  it('8. a guest token only ever sees its own folio', async () => {
    const a = await ctx.api().get(`${V1}/guest/folio`).set(bearer(guestA)).expect(200);
    const b = await ctx.api().get(`${V1}/guest/folio`).set(bearer(guestB)).expect(200);
    expect(a.body.data.lines.every((l: any) => l.stayId === stayA.id)).toBe(true);
    expect(b.body.data.lines.every((l: any) => l.stayId === stayB.id)).toBe(true);
  });

  it('9. adding another stay id changes nothing or is rejected', async () => {
    const res = await ctx.api().get(`${V1}/guest/stay`).query({ stayId: stayB.id }).set(bearer(guestA)).expect(200);
    expect(res.body.data.stay.id).toBe(stayA.id);
    const menu = await ctx.model('MenuItem').findOne({ name: 'Masala Chai' }).lean() as any;
    await ctx.api().post(`${V1}/guest/orders`).set(bearer(guestA))
      .send({ stayId: stayB.id, items: [{ menuItemId: String(menu._id), qty: 1 }], billTo: 'ROOM' })
      .expect(400);
  });

  it('guests cannot reach manager APIs; KITCHEN cannot reach financial ones', async () => {
    for (const path of ['/rooms', `/entries?date=${ctx.today}`, '/stock', '/kots', '/users']) {
      await ctx.api().get(`${V1}${path}`).set(bearer(guestA)).expect(403);
    }
    await ctx.api().get(`${V1}/entries`).query({ date: ctx.today }).set(bearer(ctx.token.KITCHEN)).expect(403);
    await ctx.api().get(`${V1}/kots`).set(bearer(ctx.token.KITCHEN)).expect(200);
    await ctx.api().get(`${V1}/rooms`).expect(401);
  });

  it('a public token reads menu and room types and can only request a booking', async () => {
    const pub = (await ctx.api().post(`${V1}/auth/guest/public-token`).expect(200)).body.data.accessToken;
    await ctx.api().get(`${V1}/guest/menu`).set(bearer(pub)).expect(200);
    const types = await ctx.api().get(`${V1}/guest/room-types`).set(bearer(pub)).expect(200);
    await ctx.api().get(`${V1}/guest/stay`).set(bearer(pub)).expect(403);
    await ctx.api().get(`${V1}/guest/folio`).set(bearer(pub)).expect(403);
    const arrival = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const departure = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const standard = types.body.data.find((t: any) => t.name === 'Standard');
    const res = await ctx.api().post(`${V1}/guest/bookings`).set(bearer(pub))
      .send({ guestName: 'Visitor', phone: '9700000099', roomTypeId: standard.id, rooms: 2, pax: 2, arrivalDate: arrival, departureDate: departure })
      .expect(201);
    expect(res.body.data.booking.amount).toBe(7200); // 1800 × 2 nights × 2 rooms, from the database
    expect(res.body.data.booking.status).toBe('REQUESTED');
  });

  it('10 and 11. a room-billed order lands on the right folio at server prices and in the kitchen queue', async () => {
    const before = await ctx.api().get(`${V1}/guest/folio`).set(bearer(guestA)).expect(200);
    const order = await ctx.api().post(`${V1}/guest/orders`).set(bearer(guestA))
      .send({ items: [{ menuItemId: await ctx.menuId('Veg Thali'), qty: 2, note: 'less spicy' }], billTo: 'ROOM', note: '' })
      .expect(201);
    const kot = order.body.data.kot;
    expect(kot).toMatchObject({ source: 'GUEST_APP', stayId: stayA.id, total: 462, cgst: 11, sgst: 11 }); // 440 + 5%

    const after = await ctx.api().get(`${V1}/guest/folio`).set(bearer(guestA)).expect(200);
    expect(after.body.data.balance - before.body.data.balance).toBeCloseTo(462);
    const other = await ctx.api().get(`${V1}/guest/folio`).set(bearer(guestB)).expect(200);
    expect(other.body.data.lines.map((l: any) => l.kotId)).not.toContain(kot.id);

    const queue = await ctx.api().get(`${V1}/kots`).set(bearer(ctx.token.KITCHEN)).expect(200);
    expect(queue.body.data.find((k: any) => k.id === kot.id)).toMatchObject({ roomNumber: '203', status: 'PLACED' });
    await ctx.api().patch(`${V1}/kots/${kot.id}/status`).set(bearer(ctx.token.KITCHEN)).send({ status: 'PREPARING' }).expect(200);
  });

  it('staff see guest requests and feedback with room and guest; guests update nothing', async () => {
    const created = await ctx.api().post(`${V1}/guest/service-requests`).set(bearer(guestA)).send({ key: 'laundry', note: 'Two shirts' }).expect(201);
    const id = created.body.data.id;
    await ctx.api().post(`${V1}/guest/feedback`).set(bearer(guestA)).send({ rating: 4, text: 'Nice' }).expect(201);

    const list = await ctx.api().get(`${V1}/service-requests`).query({ status: 'SENT' }).set(staff()).expect(200);
    expect(list.body.data.find((r: any) => r.id === id)).toMatchObject({ roomNumber: '203', guestName: 'Guest A', label: 'Laundry pickup' });
    const updated = await ctx.api().patch(`${V1}/service-requests/${id}`).set(staff()).send({ status: 'IN_PROGRESS' }).expect(200);
    expect(updated.body.data.status).toBe('IN_PROGRESS');
    await ctx.api().patch(`${V1}/service-requests/${id}`).set(bearer(guestA)).send({ status: 'DONE' }).expect(403);

    const feedback = await ctx.api().get(`${V1}/feedback`).set(bearer(ctx.token.MANAGER)).expect(200);
    expect(feedback.body.data[0]).toMatchObject({ roomNumber: '203', guestName: 'Guest A', rating: 4 });
    await ctx.api().get(`${V1}/feedback`).set(staff()).expect(403);
  });

  it('a pay-now order stays off the folio', async () => {
    const before = await ctx.api().get(`${V1}/guest/folio`).set(bearer(guestA)).expect(200);
    await ctx.api().post(`${V1}/guest/orders`).set(bearer(guestA))
      .send({ items: [{ menuItemId: await ctx.menuId('Cold Drink'), qty: 1 }], billTo: 'PAY_NOW' })
      .expect(201);
    const after = await ctx.api().get(`${V1}/guest/folio`).set(bearer(guestA)).expect(200);
    expect(after.body.data.balance).toBe(before.body.data.balance);
  });

  it('client-sent prices are rejected, not trusted', async () => {
    await ctx.api().post(`${V1}/guest/orders`).set(bearer(guestA))
      .send({ items: [{ menuItemId: await ctx.menuId('Veg Thali'), qty: 1, price: 1 }], billTo: 'ROOM' })
      .expect(400);
  });

  it('live events reach staff and only the matching guest', async () => {
    await new Promise<void>((resolve) => ctx.app.getHttpServer().listen(0, resolve));
    const port = (ctx.app.getHttpServer().address() as AddressInfo).port;
    const connect = (token: string) =>
      new Promise<Socket>((resolve, reject) => {
        const s = io(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'] });
        s.on('connect', () => setTimeout(() => resolve(s), 200));
        s.on('connect_error', reject);
      });
    const [hotel, a, b] = await Promise.all([connect(ctx.token.STAFF), connect(guestA), connect(guestB)]);
    const got = { hotel: 0, a: 0, b: 0 };
    hotel.on('kot.created', () => got.hotel++);
    a.on('kot.created', () => got.a++);
    b.on('kot.created', () => got.b++);
    await ctx.api().post(`${V1}/guest/orders`).set(bearer(guestA))
      .send({ items: [{ menuItemId: await ctx.menuId('Masala Chai'), qty: 1 }], billTo: 'ROOM' })
      .expect(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toEqual({ hotel: 1, a: 1, b: 0 });
    [hotel, a, b].forEach((s) => s.close());
    await new Promise((resolve) => ctx.app.getHttpServer().close(resolve));
  });

  it('a checked-out guest token stops working everywhere', async () => {
    await ctx.api().post(`${V1}/stays/${stayB.id}/checkout`).set(staff()).send({}).expect(200);
    for (const path of ['stay', 'folio', 'orders', 'menu']) {
      const res = await ctx.api().get(`${V1}/guest/${path}`).set(bearer(guestB)).expect(401);
      expect(res.body.code).toBe('STAY_ENDED');
    }
  });
});

describe('Public browsing and booking', () => {
  const daysFromNow = (n: number) => {
    const d = new Date(`${ctx.today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const typeId = async (name: string) => String(((await ctx.model('RoomType').findOne({ name }).lean()) as any)._id);
  const form = async (phone: string, over: Record<string, unknown> = {}) => ({
    guestName: 'Web Visitor', phone, otp: '000000', roomTypeId: await typeId('Deluxe'),
    rooms: 1, pax: 2, arrivalDate: daysFromNow(3), departureDate: daysFromNow(5), note: '', ...over,
  });
  const sendOtp = async (phone: string) => {
    await ctx.api().post(`${V1}/public/bookings/request-otp`).send({ phone }).expect(200);
    return lastOtp;
  };

  it('room types need no token', async () => {
    const res = await ctx.api().get(`${V1}/public/room-types`).expect(200);
    expect(res.body.data).toHaveLength(4);
    expect(res.body.data[0]).toMatchObject({ name: 'Standard', tariff: 1800, sizeSqft: 180, sleeps: 2 });
  });

  it('books with a correct OTP, at the server price, once only', async () => {
    const otp = await sendOtp('9600000001');
    const res = await ctx.api().post(`${V1}/public/bookings`).send(await form('9600000001', { otp })).expect(201);
    expect(res.body.data.booking).toEqual({ id: expect.any(String), ref: expect.stringMatching(/^GA\d+/), amount: 5200, status: 'REQUESTED' });
    expect((await ctx.model('Booking').findById(res.body.data.booking.id).lean() as any).source).toBe('GuestApp');
    await ctx.api().post(`${V1}/public/bookings`).send(await form('9600000001', { otp })).expect(400);
  });

  it('an OTP only works for its own phone', async () => {
    const otp = await sendOtp('9600000002');
    const res = await ctx.api().post(`${V1}/public/bookings`).send(await form('9600000003', { otp })).expect(400);
    expect(res.body.code).toBe('INVALID_OTP');
  });

  it('five wrong tries kill the OTP', async () => {
    const otp = await sendOtp('9600000004');
    const wrong = otp === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) await ctx.api().post(`${V1}/public/bookings`).send(await form('9600000004', { otp: wrong })).expect(400);
    await ctx.api().post(`${V1}/public/bookings`).send(await form('9600000004', { otp })).expect(400);
  });

  it('an expired OTP is rejected', async () => {
    const otp = await sendOtp('9600000005');
    await ctx.model('OtpChallenge').updateMany({ phone: '9600000005' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await ctx.api().post(`${V1}/public/bookings`).send(await form('9600000005', { otp })).expect(400);
  });

  it('a failed booking does not use up the OTP', async () => {
    const otp = await sendOtp('9600000006');
    await ctx.api().post(`${V1}/public/bookings`).send(await form('9600000006', { otp, rooms: 11 })).expect(400);
    await ctx.api().post(`${V1}/public/bookings`).send(await form('9600000006', { otp })).expect(201);
  });

  it('limits OTPs per phone with 429', async () => {
    for (let i = 0; i < 3; i++) await sendOtp('9600000007');
    const res = await ctx.api().post(`${V1}/public/bookings/request-otp`).send({ phone: '9600000007' }).expect(429);
    expect(res.body.code).toBe('TOO_MANY_REQUESTS');
  });

  it('validates the form on the server', async () => {
    const phone = '9600000008';
    const post = async (over: Record<string, unknown>) => ctx.api().post(`${V1}/public/bookings`).send(await form(phone, over));
    const bulk = await post({ rooms: 11 });
    expect([bulk.status, bulk.body.message]).toEqual([400, 'For bulk booking, please contact the front desk.']);
    expect((await post({ arrivalDate: daysFromNow(-1) })).body.code).toBe('INVALID_DATES');
    expect((await post({ departureDate: daysFromNow(3) })).body.code).toBe('INVALID_DATES');
    expect((await post({ departureDate: daysFromNow(34) })).body.code).toBe('INVALID_DATES');
    expect((await post({ pax: 3 })).body.code).toBe('TOO_MANY_GUESTS');
    expect((await post({ rooms: 2, pax: 4 })).body.code).toBe('INVALID_OTP'); // fits, so it reaches the OTP check
    expect((await post({ amount: '1.00' })).status).toBe(400);
    expect((await ctx.api().post(`${V1}/public/bookings/request-otp`).send({ phone: '12345' })).status).toBe(400);
    expect((await ctx.api().post(`${V1}/public/bookings/request-otp`).send({ phone: '+91 9600000009' })).status).toBe(200);
  });
});

describe('API contract with the front-ends', () => {
  it('login returns tokens at the top level and in data; refresh and logout work', async () => {
    const res = await ctx.api().post(`${V1}/auth/staff/login`).send({ identifier: '9100000002', password: 'password-for-tests' }).expect(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBe(res.body.refreshToken);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    const refreshed = await ctx.api().post(`${V1}/auth/refresh`).send({ refreshToken: res.body.refreshToken }).expect(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    await ctx.api().post(`${V1}/auth/logout`).set(bearer(refreshed.body.accessToken)).send({}).expect(200);
    await ctx.api().get(`${V1}/auth/me`).set(bearer(refreshed.body.accessToken)).expect(401);
    await ctx.api().post(`${V1}/auth/refresh`).send({ refreshToken: res.body.refreshToken }).expect(401);
    // Restore the shared STAFF token used by later tests.
    ctx.token.STAFF = (await ctx.api().post(`${V1}/auth/staff/login`).send({ identifier: '9100000002', password: 'password-for-tests' })).body.accessToken;
  });

  it('errors use { statusCode, code, message }; unknown fields are rejected', async () => {
    const res = await ctx.api().post(`${V1}/entries`).set(staff()).send({ ...(await newEntry()), hacker: true }).expect(400);
    expect(res.body).toEqual({ statusCode: 400, code: 'VALIDATION_ERROR', message: expect.stringContaining('hacker') });
    await ctx.api().patch(`${V1}/entries/not-an-id`).set(staff()).send({}).expect(400);
    await ctx.api().get(`${V1}/entries`).query({ 'date[$ne]': 'x' }).set(staff()).expect(400);
  });

  it('rooms have the fields the manager app reads', async () => {
    const res = await ctx.api().get(`${V1}/rooms`).set(staff()).expect(200);
    expect(res.body.meta).toBeDefined();
    expect(res.body.data).toHaveLength(18);
    const room = res.body.data.find((r: any) => r.number === '203');
    expect(room).toMatchObject({ status: 'OCCUPIED', roomType: { name: 'Executive', tariff: 3400 }, currentStay: { guestName: 'Guest A' } });
    expect(typeof room.currentStay.balance).toBe('number');
    expect(room._id).toBeUndefined();
    expect(room.deletedAt).toBeUndefined();
  });

  it('check-in posts tariff + 12% GST to the folio; changing dates rewrites that line', async () => {
    const stay = await checkIn(ctx, '205', 'Tariff Guest', '9700000005'); // Standard, 1800 × 2
    const lines = () => ctx.model('FolioLine').find({ stayId: stay.id, source: 'TARIFF' }).lean();
    expect((await lines())[0].amount.toString()).toBe('4032.00');
    const later = new Date(`${stay.checkIn}T00:00:00Z`);
    later.setUTCDate(later.getUTCDate() + 3);
    await ctx.api().patch(`${V1}/stays/${stay.id}`).set(staff()).send({ checkOut: later.toISOString().slice(0, 10) }).expect(200);
    const after = await lines();
    expect(after).toHaveLength(1);
    expect(after[0].amount.toString()).toBe('6048.00');
  });

  it('settling a table bill posts once and only from KOT totals', async () => {
    const kot = await ctx.api().post(`${V1}/kots`).set(staff())
      .send({ tableLabel: 'Table 4', billTo: 'PAY_NOW', items: [{ menuItemId: await ctx.menuId('Dal Tadka'), qty: 1, note: '' }] })
      .expect(201);
    const settle = { kotIds: [kot.body.data.kot.id], mode: 'CASH', businessDate: ctx.today, time: '20:00' };
    const res = await ctx.api().post(`${V1}/bills/settle`).set(staff()).send(settle).expect(200);
    expect(res.body.data.entry.amount).toBe(189); // 180 + 5%
    expect((await ctx.api().post(`${V1}/bills/settle`).set(staff()).send(settle).expect(409)).body.code).toBe('KOT_ALREADY_SETTLED');
  });

  it('stock adjusts atomically and cannot go negative', async () => {
    const stock = await ctx.api().get(`${V1}/stock`).set(staff()).expect(200);
    const lpg = stock.body.data.find((s: any) => s.item === 'LPG cylinder');
    const adjusted = await ctx.api().post(`${V1}/stock/${lpg.id}/adjust`).set(staff()).send({ delta: '-1.00', reason: 'Used' }).expect(200);
    expect(adjusted.body.data.item.qty).toBe(2);
    await ctx.api().post(`${V1}/stock/${lpg.id}/adjust`).set(staff()).send({ delta: '-9.00', reason: 'Used' }).expect(409);
    expect(await ctx.model('StockMovement').countDocuments({ stockItemId: lpg.id })).toBe(1);
  });

  it('attendance is one mark per person per date', async () => {
    const staffList = await ctx.api().get(`${V1}/staff`).set(staff()).expect(200);
    const body = { staffId: staffList.body.data[0].id, businessDate: ctx.today, mark: 'P' };
    await ctx.api().put(`${V1}/attendance`).set(staff()).send(body).expect(200);
    await ctx.api().put(`${V1}/attendance`).set(staff()).send({ ...body, mark: 'L' }).expect(200);
    const marks = await ctx.api().get(`${V1}/attendance`).query({ date: ctx.today }).set(staff()).expect(200);
    expect(marks.body.data).toHaveLength(1);
    expect(marks.body.data[0].mark).toBe('L');
  });

  it('invoice numbers and GST come from the server', async () => {
    const res = await ctx.api().post(`${V1}/invoices`).set(staff())
      .send({ businessDate: ctx.today, party: 'Acme', partyGstin: null, stayId: null, lines: [{ description: 'Room', kind: 'ROOM', qty: 2, rate: '1000.00' }, { description: 'Food', kind: 'FOOD', qty: 1, rate: '100.00' }] })
      .expect(201);
    expect(res.body.data).toMatchObject({ number: 'MT-000001', taxable: 2100, cgst: 122.5, sgst: 122.5, total: 2345 });
  });

  it('all eight reports build as JSON and XLSX; restricted to management', async () => {
    const owner = bearer(ctx.token.OWNER);
    for (const key of ['daily', 'cash', 'rooms', 'bookings', 'expenses', 'stock', 'staff', 'online']) {
      const json = await ctx.api().get(`${V1}/reports/${key}`).query({ date: ctx.today }).set(owner).expect(200);
      expect(Array.isArray(json.body.data.rows)).toBe(true);
      const file = await ctx.api().get(`${V1}/reports/${key}`).query({ date: ctx.today, format: 'xlsx' }).set(owner).buffer().parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(file.headers['content-type']).toContain('spreadsheetml');
      expect((file.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    }
    await ctx.api().get(`${V1}/reports/daily`).set(staff()).expect(403);
    await ctx.api().get(`${V1}/reports/nope`).set(owner).expect(400);
  });

  it('only OWNER manages users and tariffs', async () => {
    const types = await ctx.api().get(`${V1}/room-types`).set(staff()).expect(200);
    const suite = types.body.data.find((t: any) => t.name === 'Suite');
    await ctx.api().patch(`${V1}/room-types/${suite.id}`).set(bearer(ctx.token.MANAGER)).send({ tariff: '6000.00' }).expect(403);
    await ctx.api().patch(`${V1}/room-types/${suite.id}`).set(bearer(ctx.token.OWNER)).send({ tariff: '6000.00' }).expect(200);
    expect(((await ctx.model('Room').findOne({ number: '302' }).lean()) as any).rate.toString()).toBe('6000.00');
    await ctx.api().get(`${V1}/users`).set(bearer(ctx.token.MANAGER)).expect(403);
    const users = await ctx.api().get(`${V1}/users`).set(bearer(ctx.token.OWNER)).expect(200);
    expect(JSON.stringify(users.body)).not.toContain('passwordHash');
  });
});
