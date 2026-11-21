import { bearer, bootApp, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;
let standard: string;

beforeAll(async () => {
  ctx = await bootApp();
  standard = (await ctx.api().get(`${V1}/room-types`).set(bearer(ctx.token.STAFF)).expect(200)).body.data.find((t: any) => t.name === 'Standard').id;
});

afterAll(async () => {
  await ctx.app.close();
});

const admin = () => bearer(ctx.token.ADMIN);
const mgr = () => bearer(ctx.token.MANAGER);
const staff = () => bearer(ctx.token.STAFF);
const day = (n: number) => {
  const d = new Date(`${ctx.today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
let seq = 0;
// Each booking holds a room of its own, away from the rooms the tests check into.
const roomFor = async (n: number) => String(((await ctx.model('Room').find().sort({ number: 1 }).lean()) as any[])[n + 4]._id);
const book = async (arrival: number, status?: string) => {
  const b = (await ctx.api().post(`${V1}/bookings`).set(staff())
    .send({ source: 'Agoda', ref: `AG-${++seq}`, guestName: `Guest ${seq}`, phone: `98770000${String(seq).padStart(2, '0')}`, roomId: await roomFor(seq), pax: 1, arrivalDate: day(arrival), departureDate: day(arrival + 2), amount: '2000.00' })
    .expect(201)).body.data;
  if (status) await ctx.api().patch(`${V1}/bookings/${b.id}`).set(mgr()).send({ status }).expect(200);
  return b.id as string;
};
const statusOf = async (id: string) => ((await ctx.model('Booking').findById(id).lean()) as any).status;

describe('NO_SHOW', () => {
  const ids: Record<string, string> = {};

  it('closing the day marks only past, unchecked CONFIRMED / ARRIVING bookings, each audited', async () => {
    ids.today = await book(0);
    ids.past = await book(-1, 'ARRIVING');
    ids.future = await book(1);
    ids.cancelled = await book(0, 'CANCELLED');
    ids.checkedIn = await book(0);
    await ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId: await ctx.roomId('101'), guestName: 'In', phone: '9877000099', nights: 2, bookingId: ids.checkedIn }).expect(201);
    ids.requested = await book(-1);
    await ctx.model('Booking').updateOne({ _id: ids.requested }, { $set: { status: 'REQUESTED' } });

    await ctx.api().post(`${V1}/business-day/close`).set(admin()).send({ businessDate: ctx.today, countedCash: '0', note: 'test', time: '23:00' }).expect(200);

    expect(await statusOf(ids.today)).toBe('NO_SHOW');
    expect(await statusOf(ids.past)).toBe('NO_SHOW');
    expect(await statusOf(ids.future)).toBe('CONFIRMED');
    expect(await statusOf(ids.cancelled)).toBe('CANCELLED');
    expect(await statusOf(ids.checkedIn)).toBe('CHECKED_IN');
    expect(await statusOf(ids.requested)).toBe('REQUESTED');
    const logs = (await ctx.model('AuditLog').find({ action: 'BOOKING_NO_SHOW' }).lean()) as any[];
    expect(logs.map((l) => l.details.bookingId).sort()).toEqual([ids.today, ids.past].sort());
    expect(logs.find((l) => l.details.bookingId === ids.past).details).toMatchObject({ from: 'ARRIVING', to: 'NO_SHOW' });
  });

  it('a NO_SHOW guest who turns up late can still be checked in against the booking', async () => {
    const last = (await ctx.api().get(`${V1}/business-day/current`).set(admin()).expect(200)).body.data.lastClosingBalance;
    await ctx.api().post(`${V1}/business-day/start`).set(admin()).send({ businessDate: day(1), openingBalance: String(last), time: '08:00' }).expect(200);
    const stay = (await ctx.api().post(`${V1}/stays`).set(staff())
      .send({ roomId: await ctx.roomId('102'), guestName: 'Late', phone: '9877000098', nights: 1, bookingId: ids.today }).expect(201)).body.data.stay;
    expect(await statusOf(ids.today)).toBe('CHECKED_IN');
    expect(stay.bookingId).toBe(ids.today);
  });

  it('PATCH: NO_SHOW can be set, and revived to CONFIRMED / ARRIVING with a new arrival date', async () => {
    expect((await ctx.api().patch(`${V1}/bookings/${ids.past}`).set(mgr()).send({ status: 'CONFIRMED' }).expect(400)).body.code).toBe('ARRIVAL_REQUIRED');
    const revived = (await ctx.api().patch(`${V1}/bookings/${ids.past}`).set(mgr()).send({ status: 'ARRIVING', arrivalDate: day(2), departureDate: day(4) }).expect(200)).body.data;
    expect(revived).toMatchObject({ status: 'ARRIVING', arrivalDate: day(2) });
    await ctx.api().patch(`${V1}/bookings/${ids.future}`).set(mgr()).send({ status: 'NO_SHOW' }).expect(200);
    await ctx.api().patch(`${V1}/bookings/${ids.future}`).set(mgr()).send({ status: 'CANCELLED' }).expect(200);
  });

  it('GET /bookings: status, excludeStatus and arrival range filters; soonest arrival first', async () => {
    const list = async (q: object) => (await ctx.api().get(`${V1}/bookings`).query(q).set(staff()).expect(200)).body.data;
    const all = await list({});
    const arrivals = all.map((b: any) => b.arrivalDate);
    expect(arrivals).toEqual([...arrivals].sort());
    expect((await list({ excludeStatus: 'CHECKED_IN' })).some((b: any) => b.status === 'CHECKED_IN')).toBe(false);
    expect((await list({ excludeStatus: 'CHECKED_IN,CANCELLED' })).every((b: any) => !['CHECKED_IN', 'CANCELLED'].includes(b.status))).toBe(true);
    expect((await list({ status: 'NO_SHOW' })).every((b: any) => b.status === 'NO_SHOW')).toBe(true);
    expect((await list({ status: 'ARRIVING,CONFIRMED' })).map((b: any) => b.id)).toContain(ids.past);
    const ranged = await list({ from: day(0), to: day(1) });
    expect(ranged.length).toBeGreaterThan(0);
    expect(ranged.every((b: any) => b.arrivalDate >= day(0) && b.arrivalDate <= day(1))).toBe(true);
    await ctx.api().get(`${V1}/bookings`).query({ status: 'LOST' }).set(staff()).expect(400);
    await ctx.api().get(`${V1}/bookings`).query({ from: day(2), to: day(1) }).set(staff()).expect(400);
  });
});
