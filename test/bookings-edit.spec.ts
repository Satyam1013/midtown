import { bearer, bootApp, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;
let standard: string;
let deluxe: string;

beforeAll(async () => {
  ctx = await bootApp();
  const types = (await ctx.api().get(`${V1}/room-types`).set(bearer(ctx.token.STAFF)).expect(200)).body.data;
  standard = types.find((t: any) => t.name === 'Standard').id;
  deluxe = types.find((t: any) => t.name === 'Deluxe').id;
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
// Every desk booking holds a room; each test booking gets a room of its own.
const freeRoom = async () => String(((await ctx.model('Room').find({ roomTypeId: standard }).sort({ number: 1 }).lean()) as any[])[seq % 2]._id);
const create = async (over: object = {}) => {
  const n = ++seq;
  const arrival = 5 + n * 3; // no two test bookings overlap
  return (await ctx.api().post(`${V1}/bookings`).set(staff())
    .send({ source: 'MakeMyTrip', ref: `MMT-${n}`, guestName: 'Rahul', phone: '9844000001', roomId: await freeRoom(), pax: 2, arrivalDate: day(arrival), departureDate: day(arrival + 2), amount: '3000.00', payment: 'Prepaid', ...over })
    .expect(201)).body.data;
};
const patch = (id: string, body: object, as = mgr()) => ctx.api().patch(`${V1}/bookings/${id}`).set(as).send(body);
const listed = async () => (await ctx.api().get(`${V1}/bookings`).set(staff()).expect(200)).body.data;

describe('PATCH /bookings/:id', () => {
  it('edits any field and returns the booking as GET /bookings shows it', async () => {
    const b = await create();
    const res = (await patch(b.id, {
      guestName: 'Rahul Sharma', phone: '9844000002', ref: 'MMT-NEW', payment: 'Pay at hotel', note: 'Late arrival',
      departureDate: day(9), amount: '4500.00', status: 'ARRIVING',
    }).expect(200)).body.data;
    expect(res).toMatchObject({ id: b.id, guestName: 'Rahul Sharma', phone: '9844000002', ref: 'MMT-NEW', payment: 'Pay at hotel', note: 'Late arrival', departureDate: day(9), amount: 4500, status: 'ARRIVING', roomId: b.roomId, roomNumber: expect.any(String) });
    const row = (await listed()).find((x: any) => x.id === b.id);
    expect(Object.keys(res).sort()).toEqual(Object.keys(row).sort());
    expect(await ctx.model('AuditLog').countDocuments({ action: 'BOOKING_UPDATE', 'details.bookingId': b.id })).toBe(1);
  });

  it('moving to a room of another type and changing guests reprice; a date change keeps the booked rates', async () => {
    const b = await create({ source: 'Phone', ref: null, amount: undefined, pax: 1 });
    const deluxeRoom = String(((await ctx.model('Room').findOne({ roomTypeId: deluxe }).lean()) as any)._id);
    expect((await patch(b.id, { roomTypeId: deluxe }).expect(409)).body.code).toBe('ROOM_NOT_AVAILABLE'); // not the room's type
    const res = (await patch(b.id, { roomId: deluxeRoom, pax: 2 }).expect(200)).body.data;
    expect(res).toMatchObject({ rooms: 1, pax: 2, roomTypeId: deluxe, roomId: deluxeRoom });
    expect(res.roomLines.map((l: any) => [l.roomTypeId, l.guests])).toEqual([[deluxe, 2]]);
    const perNight = res.roomLines[0].rate;
    expect(res.amount).toBe(perNight * 2);
    // Phone bookings are priced by the server: a client amount is ignored.
    const longer = (await patch(b.id, { departureDate: day(5 + seq * 3 + 4), amount: '1.00' }).expect(200)).body.data;
    expect(longer.amount).toBe(perNight * 4);
    expect(longer.roomLines.map((l: any) => l.rate)).toEqual(res.roomLines.map((l: any) => l.rate));
  });

  it('validates dates, rooms, amount and status', async () => {
    const b = await create();
    expect((await patch(b.id, { departureDate: b.arrivalDate }).expect(400)).body.code).toBe('INVALID_DATES');
    expect((await patch(b.id, { arrivalDate: b.departureDate }).expect(400)).body.code).toBe('INVALID_DATES');
    await patch(b.id, { rooms: 0 }).expect(400);
    await patch(b.id, { amount: '-5' }).expect(400);
    await patch(b.id, { status: 'CHECKED_OUT' }).expect(400);
    await patch(b.id, { role: 'ADMIN' }).expect(400);
    await patch('64b7f0000000000000000000', { note: 'x' }).expect(404);
  });

  it('ref stays unique per source: 409', async () => {
    const a = await create({ ref: 'DUP-1' });
    const b = await create({ ref: 'DUP-2' });
    expect((await patch(b.id, { ref: 'DUP-1' }).expect(409)).body.code).toBe('BOOKING_EXISTS');
    await patch(b.id, { ref: 'DUP-1', source: 'Agoda' }).expect(200);
    expect((await patch(a.id, { source: 'Agoda' }).expect(409)).body.code).toBe('BOOKING_EXISTS');
  });

  it('once checked in, arrival, rooms, room type and guests are locked: 409 BOOKING_LOCKED', async () => {
    const b = await create({ arrivalDate: ctx.today, departureDate: day(2), roomId: await ctx.roomId('101') });
    await ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId: await ctx.roomId('101'), guestName: 'Rahul', phone: '9844000001', nights: 2, bookingId: b.id }).expect(201);
    const other = String(((await ctx.model('Room').findOne({ roomTypeId: deluxe }).lean()) as any)._id);
    for (const body of [{ arrivalDate: day(1) }, { roomId: other }, { roomTypeId: deluxe }, { pax: 1 }]) {
      expect((await patch(b.id, body).expect(409)).body.code).toBe('BOOKING_LOCKED');
    }
    await patch(b.id, { note: 'VIP', departureDate: day(3), payment: 'Paid' }).expect(200);
    await patch(b.id, { arrivalDate: ctx.today, roomTypeId: standard }).expect(200); // unchanged values are fine
  });

  it('ADMIN and MANAGER edit; STAFF gets 403', async () => {
    const b = await create();
    await patch(b.id, { note: 'by admin' }, admin()).expect(200);
    await patch(b.id, { note: 'by staff' }, staff()).expect(403);
  });
});

describe('DELETE /bookings/:id', () => {
  it('ADMIN only: soft delete, 204, gone from the list, audited', async () => {
    const b = await create();
    const res = await ctx.api().delete(`${V1}/bookings/${b.id}`).set(mgr()).expect(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', message: 'Admin access required' });
    await ctx.api().delete(`${V1}/bookings/${b.id}`).set(admin()).expect(204);
    expect((await listed()).some((x: any) => x.id === b.id)).toBe(false);
    expect(await ctx.model('Booking').countDocuments({ _id: b.id }).setOptions({ withDeleted: true })).toBe(1);
    const log = (await ctx.model('AuditLog').findOne({ action: 'BOOKING_DELETE', 'details.bookingId': b.id }).lean()) as any;
    expect(log.details).toMatchObject({ ref: b.ref, source: 'MakeMyTrip', guestName: 'Rahul' });
    expect(log.userId).toBeTruthy();
    await ctx.api().delete(`${V1}/bookings/${b.id}`).set(admin()).expect(404);
    await patch(b.id, { note: 'x' }).expect(404);
    // Its OTA reference can be used again.
    await create({ ref: b.ref });
  });

  it('a booking with a checked-in room is 409 BOOKING_IN_USE; cancel works', async () => {
    const b = await create({ arrivalDate: ctx.today, departureDate: day(2), roomId: await ctx.roomId('102') });
    await ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId: await ctx.roomId('102'), guestName: 'Rahul', phone: '9844000001', nights: 2, bookingId: b.id }).expect(201);
    expect((await ctx.api().delete(`${V1}/bookings/${b.id}`).set(admin()).expect(409)).body.code).toBe('BOOKING_IN_USE');
    await patch(b.id, { status: 'CANCELLED' }).expect(200);
  });

  it('404 for an unknown id', async () => {
    await ctx.api().delete(`${V1}/bookings/64b7f0000000000000000000`).set(admin()).expect(404);
  });
});
