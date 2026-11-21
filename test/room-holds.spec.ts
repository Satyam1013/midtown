import { bearer, bootApp, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;

beforeAll(async () => {
  ctx = await bootApp();
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
const created = (r: any) => {
  if (r.status !== 201) throw new Error(`expected 201, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const book = (number: string, from: number, to: number, extra: object = {}) =>
  ctx.roomId(number).then((roomId) =>
    ctx.api().post(`${V1}/bookings`).set(staff())
      .send({ source: 'Phone', guestName: `Booker ${++seq}`, phone: `98880000${String(seq).padStart(2, '0')}`, roomId, pax: 1, arrivalDate: day(from), departureDate: day(to), ...extra }),
  );
const status = async (number: string) => ((await ctx.model('Room').findOne({ number }).lean()) as any).status;
const walkIn = async (number: string, nights: number, phone: string) =>
  ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId: await ctx.roomId(number), guestName: 'Walk In', phone, nights });

describe('Booking a room', () => {
  it('overlapping bookings of a room are 409; back-to-back ones (checkout day = arrival day) are fine', async () => {
    await book('301', 10, 13).then(created);
    for (const [from, to] of [[12, 14], [9, 11], [10, 13], [11, 12]]) {
      expect((await book('301', from, to)).body.code).toBe('ROOM_NOT_AVAILABLE');
    }
    await book('301', 13, 15).then(created);
    await book('301', 8, 10).then(created);
  });

  it('a room occupied until a date can be booked from that date, not the day before', async () => {
    await walkIn('302', 2, '9888100001').then(created); // checks out day(2)
    expect((await book('302', 1, 3)).status).toBe(409);
    await book('302', 2, 4).then(created);
  });

  it('room type, capacity, out of order and maintenance are checked', async () => {
    const deluxe = (await ctx.api().get(`${V1}/room-types`).set(staff()).expect(200)).body.data.find((t: any) => t.name === 'Deluxe').id;
    expect((await book('305', 20, 21, { roomTypeId: deluxe })).body.code).toBe('ROOM_NOT_AVAILABLE'); // 305 is Executive
    await ctx.api().patch(`${V1}/rooms/${await ctx.roomId('305')}`).set(admin()).send({ sleeps: 1 }).expect(200);
    expect((await book('305', 20, 21, { pax: 2 })).body).toMatchObject({ code: 'ROOM_NOT_AVAILABLE', message: expect.stringContaining('sleeps at most 1') });

    const ooo = await ctx.roomId('306');
    await ctx.api().patch(`${V1}/rooms/${ooo}/status`).set(mgr()).send({ status: 'OOO' }).expect(200);
    expect((await book('306', 20, 21)).body.code).toBe('ROOM_NOT_AVAILABLE');
    await ctx.api().patch(`${V1}/rooms/${ooo}/status`).set(mgr()).send({ status: 'MAINTENANCE', expectedBackDate: day(25) }).expect(409); // OOO → VACANT first
    await ctx.api().patch(`${V1}/rooms/${ooo}/status`).set(mgr()).send({ status: 'VACANT' }).expect(200);
    await ctx.api().patch(`${V1}/rooms/${ooo}/status`).set(mgr()).send({ status: 'MAINTENANCE', expectedBackDate: day(25) }).expect(200);
    expect((await book('306', 20, 21)).body).toMatchObject({ code: 'ROOM_NOT_AVAILABLE', message: expect.stringContaining('maintenance') });
    await book('306', 25, 26).then(created);

    expect((await ctx.api().post(`${V1}/bookings`).set(staff()).send({ source: 'Phone', guestName: 'No room', phone: '9888000099', pax: 1, arrivalDate: day(30), departureDate: day(31) }).expect(400)).body.code).toBe('VALIDATION_ERROR');
  });

  it('two bookings racing for the same room: one wins, the other is 409', async () => {
    const results = await Promise.all([book('204', 40, 42), book('204', 41, 43)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe('PREBOOKED', () => {
  it('a booking for today turns a VACANT room PREBOOKED; only its guest can be checked in', async () => {
    const booking = (await book('101', 0, 2).then(created)).body.data;
    expect(await status('101')).toBe('PREBOOKED');
    expect((await walkIn('101', 1, '9888100002')).body.code).toBe('ROOM_NOT_AVAILABLE');
    const other = (await walkIn('102', 1, '9888100003').then(created)).body.data.stay;
    expect((await ctx.api().post(`${V1}/stays/${other.id}/shift`).set(staff()).send({ toRoomId: await ctx.roomId('101'), guests: 1, businessDate: ctx.today, time: '10:00' }).expect(409)).body.code).toBe('ROOM_NOT_VACANT');

    // The booked guest: no roomId needed, the booking's room is used.
    const stay = (await ctx.api().post(`${V1}/stays`).set(staff()).send({ guestName: 'Booked Guest', phone: '9888100004', nights: 2, bookingId: booking.id }).expect(201)).body.data.stay;
    expect(stay.roomNumber ?? (await ctx.model('Stay').findById(stay.id).populate('roomId').lean() as any).roomId.number).toBe('101');
    expect(await status('101')).toBe('OCCUPIED');
    expect(((await ctx.model('Booking').findById(booking.id).lean()) as any).status).toBe('CHECKED_IN');
  });

  it('a future booking leaves the room VACANT, shows on GET /rooms, and blocks walk-ins over those nights', async () => {
    await book('103', 3, 5).then(created);
    expect(await status('103')).toBe('VACANT');
    const row = (await ctx.api().get(`${V1}/rooms`).set(mgr()).expect(200)).body.data.find((r: any) => r.number === '103');
    expect(row.prebooking).toMatchObject({ arrivalDate: day(3), departureDate: day(5), pax: 1 });
    expect((await walkIn('103', 4, '9888100005')).body.code).toBe('ROOM_NOT_AVAILABLE');
    await walkIn('103', 3, '9888100006').then(created); // leaves on the arrival day
  });

  it('moving a booking to another room frees the old room and holds the new one', async () => {
    const b = (await book('104', 0, 1).then(created)).body.data;
    expect(await status('104')).toBe('PREBOOKED');
    const moved = (await ctx.api().patch(`${V1}/bookings/${b.id}`).set(mgr()).send({ roomId: await ctx.roomId('105') }).expect(200)).body.data;
    expect(moved).toMatchObject({ roomNumber: '105' });
    expect([await status('104'), await status('105')]).toEqual(['VACANT', 'PREBOOKED']);
    // 105 is Standard and 104 Deluxe: the booking follows its room's type.
    const standard = (await ctx.api().get(`${V1}/room-types`).set(staff()).expect(200)).body.data.find((t: any) => t.name === 'Standard').id;
    expect(moved.roomTypeId).toBe(standard);
  });

  it('cancelling or a no-show releases the room', async () => {
    const a = (await book('201', 0, 1).then(created)).body.data;
    const b = (await book('202', 0, 1).then(created)).body.data;
    expect([await status('201'), await status('202')]).toEqual(['PREBOOKED', 'PREBOOKED']);
    await ctx.api().patch(`${V1}/bookings/${a.id}`).set(mgr()).send({ status: 'CANCELLED' }).expect(200);
    await ctx.api().patch(`${V1}/bookings/${b.id}`).set(mgr()).send({ status: 'NO_SHOW' }).expect(200);
    expect([await status('201'), await status('202')]).toEqual(['VACANT', 'VACANT']);
    const deleted = (await book('201', 0, 1).then(created)).body.data;
    expect(await status('201')).toBe('PREBOOKED');
    await ctx.api().delete(`${V1}/bookings/${deleted.id}`).set(admin()).expect(204);
    expect(await status('201')).toBe('VACANT');
  });

  it('an occupied room stays OCCUPIED; once checked out and cleaned it becomes PREBOOKED', async () => {
    const stay = (await walkIn('203', 1, '9888100007').then(created)).body.data.stay;
    // A guest who leaves today (checked in yesterday): the room can be booked from today.
    await ctx.model('Stay').updateOne({ _id: stay.id }, { $set: { checkIn: day(-1), checkOut: ctx.today } });
    await book('203', 0, 2).then(created);
    expect(await status('203')).toBe('OCCUPIED');
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200);
    expect(await status('203')).toBe('DIRTY');
    await ctx.api().post(`${V1}/rooms/mark-all-clean`).set(mgr()).expect(200);
    expect(await status('203')).toBe('PREBOOKED');
  });

  it('GET /rooms/available applies the same rules', async () => {
    const free = (await ctx.api().get(`${V1}/rooms/available`).query({ from: day(10), to: day(13) }).set(staff()).expect(200)).body.data.map((r: any) => r.number);
    expect(free).not.toContain('301'); // booked 10–13
    expect(free).toContain('302');
    const later = (await ctx.api().get(`${V1}/rooms/available`).query({ from: day(15), to: day(16) }).set(staff()).expect(200)).body.data.map((r: any) => r.number);
    expect(later).toContain('301');
    await ctx.api().get(`${V1}/rooms/available`).query({ from: day(3), to: day(3) }).set(staff()).expect(400);
  });

  it('starting the arrival day turns the room PREBOOKED', async () => {
    await book('205', 1, 3).then(created);
    expect(await status('205')).toBe('VACANT');
    await ctx.api().post(`${V1}/business-day/close`).set(admin()).send({ businessDate: ctx.today, countedCash: '0', note: 'test', time: '23:00' }).expect(200);
    const last = (await ctx.api().get(`${V1}/business-day/current`).set(admin()).expect(200)).body.data.lastClosingBalance;
    await ctx.api().post(`${V1}/business-day/start`).set(admin()).send({ businessDate: day(1), openingBalance: String(last), time: '08:00' }).expect(200);
    expect(await status('205')).toBe('PREBOOKED');
  });
});
