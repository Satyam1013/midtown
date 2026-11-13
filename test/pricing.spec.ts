import { SmsService } from '../src/auth/sms.service';
import { bearer, bootApp, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;
let lastOtp = '';
const rooms: Record<string, string> = {};

beforeAll(async () => {
  ctx = await bootApp();
  jest.spyOn(ctx.app.get(SmsService), 'sendOtp').mockImplementation(async (_p, otp) => {
    lastOtp = otp;
  });
  // Floor 4, priced per room: [number, type, category, single, double]
  const plan: [string, string, string, string, string][] = [
    ['401', 'AC Standard', 'AC', '1000.00', '1500.00'],
    ['402', 'AC Standard', 'AC', '1000.00', '1500.00'],
    ['403', 'AC Deluxe', 'AC', '2000.00', '2500.00'],
    ['404', 'Non AC Standard', 'NON_AC', '700.00', '900.00'],
    ['405', 'AC Standard', 'AC', '1000.00', '1500.00'],
    ['406', 'AC Executive', 'AC', '3000.00', '3600.00'],
    ['407', 'AC Deluxe', 'AC', '2000.00', '2500.00'],
    ['408', 'Non AC New Standard', 'NON_AC', '800.00', '1000.00'],
    ['409', 'AC Standard', 'AC', '1000.00', '1500.00'],
    ['410', 'AC Standard', 'AC', '1000.00', '1500.00'],
  ];
  for (const [number, roomType, category, singleRate, doubleRate] of plan) {
    const res = await ctx.api().post(`${V1}/rooms`).set(bearer(ctx.token.MANAGER))
      .send({ number, floor: 4, category, roomType, singleRate, doubleRate, rate: singleRate })
      .expect(201);
    rooms[number] = res.body.data.id;
  }
});

afterAll(async () => {
  await ctx.app.close();
});

const staff = () => bearer(ctx.token.STAFF);
const day = (n: number) => {
  const d = new Date(`${ctx.today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const checkIn = async (room: string, phone: string, guests: number, from = 0, nights = 3, extra: object = {}) =>
  (await ctx.api().post(`${V1}/stays`).set(staff())
    .send({ roomId: rooms[room], guestName: `Guest ${room}`, phone, guests, nights, businessDate: day(from), ...extra })
    .expect(201)).body.data.stay;
const tariffTotal = async (stayId: string) =>
  (await ctx.model('FolioLine').find({ stayId, source: 'TARIFF' }).lean()).reduce((s: number, l: any) => s + Number(l.amount.toString()), 0);
const roomStatus = async (number: string) => ((await ctx.model('Room').findById(rooms[number]).lean()) as any).status;

async function guestToken(room: string, phone: string) {
  await ctx.model('OtpChallenge').deleteMany({});
  await ctx.api().post(`${V1}/auth/guest/request-otp`).send({ roomNumber: room, phone }).expect(200);
  return (await ctx.api().post(`${V1}/auth/guest/verify-otp`).send({ roomNumber: room, phone, otp: lastOtp }).expect(200)).body.data.accessToken;
}
async function shiftRequest(room: string, phone: string, note = 'Want a bigger room') {
  const token = await guestToken(room, phone);
  return (await ctx.api().post(`${V1}/guest/service-requests`).set(bearer(token)).send({ key: 'ROOM_SHIFT', note }).expect(201)).body.data.id;
}
const shift = (stayId: string, body: object) => ctx.api().post(`${V1}/stays/${stayId}/shift`).set(staff()).send({ time: '12:00', businessDate: ctx.today, ...body });

describe('Rooms', () => {
  it('GET /rooms returns category and both rates; legacy rooms fall back to rate', async () => {
    const list = (await ctx.api().get(`${V1}/rooms`).set(staff()).expect(200)).body.data;
    expect(list.find((r: any) => r.number === '403')).toMatchObject({
      category: 'AC', singleRate: 2000, doubleRate: 2500, rate: 2000, roomType: { name: 'AC Deluxe', category: 'AC' },
    });
    expect(list.find((r: any) => r.number === '101')).toMatchObject({ singleRate: 1800, doubleRate: 1800, rate: 1800 });
  });

  it('validates the type against the category and requires both rates', async () => {
    const mgr = bearer(ctx.token.MANAGER);
    const base = { number: '499', floor: 4, category: 'NON_AC', roomType: 'AC Deluxe', singleRate: '900', doubleRate: '1100' };
    expect((await ctx.api().post(`${V1}/rooms`).set(mgr).send(base).expect(400)).body.code).toBe('TYPE_CATEGORY_MISMATCH');
    expect((await ctx.api().post(`${V1}/rooms`).set(mgr).send({ ...base, roomType: 'Non AC Standard', doubleRate: undefined }).expect(400)).body.code).toBe('RATES_REQUIRED');
    await ctx.api().post(`${V1}/rooms`).set(mgr).send({ ...base, roomType: 'Non AC Standard', singleRate: '0' }).expect(400);
  });

  it('the old POST /rooms body still works', async () => {
    const types = (await ctx.api().get(`${V1}/room-types`).set(staff()).expect(200)).body.data;
    const standard = types.find((t: any) => t.name === 'Standard');
    const res = await ctx.api().post(`${V1}/rooms`).set(bearer(ctx.token.MANAGER)).send({ number: '498', floor: 4, roomTypeId: standard.id, rate: '1900.00' }).expect(201);
    expect(res.body.data).toMatchObject({ singleRate: 1900, doubleRate: 1900, rate: 1900 });
  });

  it('category types show their cheapest room as the price', async () => {
    const types = (await ctx.api().get(`${V1}/public/room-types`).expect(200)).body.data;
    expect(types.find((t: any) => t.name === 'AC Deluxe')).toMatchObject({ category: 'AC', tariff: 2000 });
  });
});

describe('Pricing by guest count', () => {
  it('1, 2, 3 and 4 guests; a client rate is ignored', async () => {
    const expected: Record<number, number> = { 1: 1000, 2: 1500, 3: 1800, 4: 2100 };
    for (const [guests, room] of [[1, '401'], [2, '402'], [3, '405'], [4, '409']] as const) {
      const stay = await checkIn(room, `95000000${guests}0`, guests, 0, 2, { rate: '1.00' });
      expect(stay).toMatchObject({ guests, rate: expected[guests], nights: 2 });
      expect(stay.roomCharges).toEqual([expect.objectContaining({ roomNumber: room, guests, rate: expected[guests], nights: 2, amount: expected[guests] * 2 })]);
      expect(await tariffTotal(stay.id)).toBeCloseTo(expected[guests] * 2 * 1.12);
      await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200);
      await ctx.api().patch(`${V1}/rooms/${rooms[room]}/status`).set(staff()).send({ status: 'VACANT' }).expect(200);
    }
    await ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId: rooms['401'], guestName: 'Too many', guests: 5 }).expect(400);
  });

  it('changing guests mid-stay reprices only the remaining nights', async () => {
    const stay = await checkIn('410', '9500000011', 1, -1, 3); // nights: D-1, D, D+1
    const res = await ctx.api().patch(`${V1}/stays/${stay.id}`).set(staff()).send({ guests: 3, businessDate: ctx.today }).expect(200);
    expect(res.body.data.stay).toMatchObject({ guests: 3, rate: 1800, nights: 3 });
    expect(res.body.data.stay.roomCharges.map((c: any) => [c.guests, c.rate, c.nights, c.amount])).toEqual([[1, 1000, 1, 1000], [3, 1800, 2, 3600]]);
    expect(await tariffTotal(stay.id)).toBeCloseTo((1000 + 3600) * 1.12);
    expect(await ctx.model('AuditLog').countDocuments({ stayId: stay.id, action: 'GUEST_COUNT_CHANGE' })).toBe(1);

    // Checkout total after a guest-count change: room charges + food − payments.
    await ctx.api().patch(`${V1}/stays/${stay.id}`).set(staff())
      .send({ payment: { kind: 'ADVANCE', amount: '1000.00', mode: 'CASH', businessDate: ctx.today, time: '10:00' } })
      .expect(200);
    const out = (await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200)).body.data;
    expect(out.bill).toEqual({ roomCharges: '5152.00', food: '0.00', otherCharges: '0.00', payments: '1000.00', total: '4152.00' });
    expect(out.folioBalance).toBe('4152.00');
  });

  it('a room price edit does not touch a stay in progress', async () => {
    const stay = await checkIn('404', '9500000012', 2, 0, 2);
    await ctx.api().patch(`${V1}/rooms/${rooms['404']}`).set(bearer(ctx.token.MANAGER)).send({ singleRate: '750.00', doubleRate: '950.00' }).expect(200);
    const list = (await ctx.api().get(`${V1}/rooms`).set(staff()).expect(200)).body.data;
    const room = list.find((r: any) => r.number === '404');
    expect(room).toMatchObject({ singleRate: 750, doubleRate: 950, rate: 750 });
    expect(room.currentStay).toMatchObject({ rate: 900, guests: 2 });
    expect(room.currentStay.roomCharges[0]).toMatchObject({ rate: 900, amount: 1800 });
    expect(await tariffTotal(stay.id)).toBeCloseTo(1800 * 1.12);
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200);
  });
});

describe('Room shift', () => {
  // Each test starts with every unoccupied floor-4 room ready.
  beforeEach(async () => {
    const occupied = (await ctx.model('Stay').find({ status: 'IN_HOUSE' }).select('roomId').lean()).map((s: any) => s.roomId);
    await ctx.model('Room').updateMany({ _id: { $in: Object.values(rooms), $nin: occupied } }, { $set: { status: 'VACANT' } });
  });

  it('needs a ROOM_SHIFT request of this stay, still open', async () => {
    const a = await checkIn('401', '9600000001', 1, -1, 3);
    const b = await checkIn('402', '9600000002', 1, -1, 3);
    await shift(a.id, { toRoomId: rooms['403'], guests: 1 }).expect(400); // requestId missing
    const tokenA = await guestToken('401', '9600000001');
    const otherKind = (await ctx.api().post(`${V1}/guest/service-requests`).set(bearer(tokenA)).send({ key: 'laundry' }).expect(201)).body.data.id;
    expect((await shift(a.id, { requestId: otherKind, toRoomId: rooms['403'], guests: 1 }).expect(400)).body.code).toBe('INVALID_SHIFT_REQUEST');
    const bRequest = await shiftRequest('402', '9600000002');
    expect((await shift(a.id, { requestId: bRequest, toRoomId: rooms['403'], guests: 1 }).expect(400)).body.code).toBe('INVALID_SHIFT_REQUEST');
    expect(await roomStatus('403')).toBe('VACANT');
    await ctx.api().post(`${V1}/stays/${a.id}/checkout`).set(staff()).send({}).expect(200);
    await ctx.api().post(`${V1}/stays/${b.id}/checkout`).set(staff()).send({}).expect(200);
    for (const r of ['401', '402']) await ctx.api().patch(`${V1}/rooms/${rooms[r]}/status`).set(staff()).send({ status: 'VACANT' }).expect(200);
    // Checking out lapsed b's open shift request.
    expect(((await ctx.model('ServiceRequest').findById(bRequest).lean()) as any).status).toBe('EXPIRED');
  });

  it('only one open shift request per stay', async () => {
    const stay = await checkIn('405', '9600000003', 1, 0, 2);
    await shiftRequest('405', '9600000003');
    const token = await guestToken('405', '9600000003');
    const dup = await ctx.api().post(`${V1}/guest/service-requests`).set(bearer(token)).send({ key: 'ROOM_SHIFT', note: 'again' }).expect(409);
    expect(dup.body.code).toBe('SHIFT_REQUEST_OPEN');
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200);
    await ctx.api().patch(`${V1}/rooms/${rooms['405']}/status`).set(staff()).send({ status: 'VACANT' }).expect(200);
  });

  it('upgrade: new segment, folio adjusted, rooms swapped, request done, then checkout total', async () => {
    const stay = await checkIn('401', '9600000004', 2, -1, 3); // 1500 × 3
    const requestId = await shiftRequest('401', '9600000004', 'Want AC Deluxe');
    const res = await shift(stay.id, { requestId, toRoomId: rooms['403'], guests: 2, rate: '1.00', reason: 'Guest asked for Deluxe' }).expect(200);
    const after = res.body.data;
    expect(after).toMatchObject({ roomId: rooms['403'], guests: 2, rate: 2500, nights: 3 });
    expect(after.roomCharges.map((c: any) => [c.roomNumber, c.rate, c.nights, c.amount])).toEqual([['401', 1500, 1, 1500], ['403', 2500, 2, 5000]]);
    expect(after.shifts).toEqual([expect.objectContaining({
      fromRoomNumber: '401', toRoomNumber: '403', fromRate: 1500, toRate: 2500, kind: 'UPGRADE', date: ctx.today, nightsBefore: 1, adjustment: 2000,
    })]);
    expect(await tariffTotal(stay.id)).toBeCloseTo((1500 + 5000) * 1.12); // (4500 + 2000) × 1.12
    expect([await roomStatus('401'), await roomStatus('403')]).toEqual(['DIRTY', 'OCCUPIED']);
    const request = (await ctx.model('ServiceRequest').findById(requestId).lean()) as any;
    expect(request).toMatchObject({ status: 'DONE', remark: 'Guest asked for Deluxe' });
    expect(String(request.handledByUserId)).toBeTruthy();
    expect(await ctx.model('AuditLog').countDocuments({ stayId: stay.id, action: 'ROOM_SHIFT' })).toBe(1);

    // Stay-linked data follows the stay to the new room.
    const listed = (await ctx.api().get(`${V1}/service-requests`).set(staff()).expect(200)).body.data.find((r: any) => r.id === requestId);
    expect(listed.roomNumber).toBe('403');
    const guest = await guestToken('403', '9600000004');
    expect((await ctx.api().get(`${V1}/guest/stay`).set(bearer(guest)).expect(200)).body.data.room.number).toBe('403');
    const chai = String(((await ctx.model('MenuItem').findOne({ name: 'Masala Chai' }).lean()) as any)._id);
    await ctx.api().post(`${V1}/guest/orders`).set(bearer(guest)).send({ items: [{ menuItemId: chai, qty: 1 }], billTo: 'ROOM' }).expect(201); // 20 + 5%
    const rooms403 = (await ctx.api().get(`${V1}/rooms`).set(staff()).expect(200)).body.data.find((r: any) => r.number === '403');
    expect(rooms403.currentStay.shifts).toHaveLength(1);

    // Checkout total after a shift: room charges + food − payments, and no cash entry from the shift.
    expect(await ctx.model('DayRegisterEntry').countDocuments({ stayId: stay.id })).toBe(0);
    const out = (await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200)).body.data;
    expect(out.bill).toEqual({ roomCharges: '7280.00', food: '21.00', otherCharges: '0.00', payments: '0.00', total: '7301.00' });
    expect(await roomStatus('403')).toBe('DIRTY');
    for (const r of ['401', '403']) await ctx.api().patch(`${V1}/rooms/${rooms[r]}/status`).set(staff()).send({ status: 'VACANT' }).expect(200);
  });

  it('downgrade gives a negative adjustment', async () => {
    const stay = await checkIn('406', '9600000005', 2, -1, 3); // 3600
    const requestId = await shiftRequest('406', '9600000005');
    const after = (await shift(stay.id, { requestId, toRoomId: rooms['404'], guests: 2 }).expect(200)).body.data; // 950 now
    expect(after.shifts[0]).toMatchObject({ kind: 'DOWNGRADE', fromRate: 3600, toRate: 950, nightsBefore: 1, adjustment: -5300 });
    expect(await tariffTotal(stay.id)).toBeCloseTo((3600 + 1900) * 1.12);
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200);
  });

  it('same price is SAME with zero adjustment', async () => {
    const stay = await checkIn('407', '9600000006', 1, -1, 3); // 2000
    const requestId = await shiftRequest('407', '9600000006', 'Noisy room');
    const after = (await shift(stay.id, { requestId, toRoomId: rooms['403'], guests: 1 }).expect(200)).body.data;
    expect(after.shifts[0]).toMatchObject({ kind: 'SAME', adjustment: 0 });
    expect(await tariffTotal(stay.id)).toBeCloseTo(6000 * 1.12);
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200);
  });

  it('an occupied target room is 409 and nothing changes', async () => {
    const a = await checkIn('409', '9600000007', 1, 0, 2);
    const b = await checkIn('410', '9600000008', 1, 0, 2);
    const requestId = await shiftRequest('409', '9600000007');
    const res = await shift(a.id, { requestId, toRoomId: rooms['410'], guests: 1 }).expect(409);
    expect(res.body.code).toBe('ROOM_NOT_VACANT');
    expect([await roomStatus('409'), await roomStatus('410')]).toEqual(['OCCUPIED', 'OCCUPIED']);
    expect(((await ctx.model('ServiceRequest').findById(requestId).lean()) as any).status).toBe('SENT');
    expect(await ctx.model('RoomShift').countDocuments({ stayId: a.id })).toBe(0);
    // A done request can't be used again.
    await shift(a.id, { requestId, toRoomId: rooms['405'], guests: 1 }).expect(200);
    expect((await shift(a.id, { requestId, toRoomId: rooms['401'], guests: 1 }).expect(409)).body.code).toBe('SHIFT_REQUEST_CLOSED');
    for (const s of [a, b]) await ctx.api().post(`${V1}/stays/${s.id}/checkout`).set(staff()).send({}).expect(200);
  });

  it('shift on the last night moves only that night', async () => {
    const stay = await checkIn('402', '9600000009', 2, -2, 3); // D-2, D-1, D
    const requestId = await shiftRequest('402', '9600000009');
    const after = (await shift(stay.id, { requestId, toRoomId: rooms['406'], guests: 2 }).expect(200)).body.data;
    expect(after.shifts[0]).toMatchObject({ nightsBefore: 2, adjustment: (3600 - 1500) * 1 });
    expect(after.roomCharges.map((c: any) => [c.roomNumber, c.nights])).toEqual([['402', 2], ['406', 1]]);
    // After the last night there is nothing left to move.
    await ctx.model('ServiceRequest').create({ stayId: stay.id, key: 'ROOM_SHIFT', label: 'Room shift' });
    const next = (await ctx.model('ServiceRequest').findOne({ stayId: stay.id, status: 'SENT' }).lean()) as any;
    expect((await shift(stay.id, { requestId: String(next._id), toRoomId: rooms['401'], guests: 2, businessDate: day(1) }).expect(400)).body.code).toBe('FUTURE_DATE');
  });

  it('rejecting a shift request needs a remark; DONE only via the shift endpoint', async () => {
    const stay = await checkIn('407', '9600000010', 1, 0, 2);
    const requestId = await shiftRequest('407', '9600000010');
    expect((await ctx.api().patch(`${V1}/service-requests/${requestId}`).set(staff()).send({ status: 'DONE' }).expect(409)).body.code).toBe('USE_SHIFT_ENDPOINT');
    expect((await ctx.api().patch(`${V1}/service-requests/${requestId}`).set(staff()).send({ status: 'REJECTED' }).expect(400)).body.code).toBe('REMARK_REQUIRED');
    const rejected = await ctx.api().patch(`${V1}/service-requests/${requestId}`).set(staff()).send({ status: 'REJECTED', remark: 'No rooms free tonight' }).expect(200);
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', remark: 'No rooms free tonight' });
    expect((await shift(stay.id, { requestId, toRoomId: rooms['401'], guests: 1 }).expect(409)).body.code).toBe('SHIFT_REQUEST_CLOSED');
  });
});
