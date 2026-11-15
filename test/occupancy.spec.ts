import { bearer, bootApp, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;
let typeId: string;
let lastOtp = '';

beforeAll(async () => {
  ctx = await bootApp();
  const { SmsService } = await import('../src/auth/sms.service');
  jest.spyOn(ctx.app.get(SmsService), 'sendOtp').mockImplementation(async (_p, otp) => {
    lastOtp = otp;
  });
});

afterAll(async () => {
  await ctx.app.close();
});

const owner = () => bearer(ctx.token.OWNER);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const quoteBody = (rooms: number, pax: number) => ({ roomTypeId: typeId, rooms, pax, arrivalDate: day(10), departureDate: day(13) });

describe('Occupancy-based room-type pricing', () => {
  it('owner creates and edits a type; responses carry numeric rates and tariff = singleRate', async () => {
    const body = { name: 'AC Family', category: 'AC', sleeps: 4, singleRate: '1500', doubleRate: '1800', additionalGuestRate: '400' };
    await ctx.api().post(`${V1}/room-types`).set(bearer(ctx.token.MANAGER)).send(body).expect(403);
    expect((await ctx.api().post(`${V1}/room-types`).set(owner()).send({ ...body, doubleRate: '1400' }).expect(400)).body.code).toBe('INVALID_RATES');
    await ctx.api().post(`${V1}/room-types`).set(owner()).send({ ...body, singleRate: '0' }).expect(400);
    await ctx.api().post(`${V1}/room-types`).set(owner()).send({ ...body, additionalGuestRate: '-1' }).expect(400);
    typeId = (await ctx.api().post(`${V1}/room-types`).set(owner()).send(body).expect(201)).body.data.id;
    for (const n of ['601', '602', '603']) {
      await ctx.api().post(`${V1}/rooms`).set(bearer(ctx.token.MANAGER)).send({ number: n, floor: 6, roomTypeId: typeId, rate: '1500' }).expect(201);
    }
    const pub = (await ctx.api().get(`${V1}/public/room-types`).expect(200)).body.data.find((t: any) => t.id === typeId);
    expect(pub).toMatchObject({ name: 'AC Family', sleeps: 4, singleRate: 1500, doubleRate: 1800, additionalGuestRate: 400, tariff: 1500 });
    // Older types without occupancy prices fall back to their tariff.
    const standard = (await ctx.api().get(`${V1}/public/room-types`)).body.data.find((t: any) => t.name === 'Standard');
    expect(standard).toMatchObject({ singleRate: 1800, doubleRate: 1800, additionalGuestRate: 0, tariff: 1800 });
    // The older PATCH body still works and keeps tariff in step.
    const patched = (await ctx.api().patch(`${V1}/room-types/${standard.id}`).set(owner()).send({ tariff: '1900' }).expect(200)).body.data;
    expect(patched).toMatchObject({ singleRate: 1900, tariff: 1900, doubleRate: 1900 });
  });

  it('quote: guests split evenly, earlier rooms first; 1 → single, 2 → double, 3+ → double + extra', async () => {
    const q = async (rooms: number, pax: number) => (await ctx.api().post(`${V1}/public/bookings/quote`).send(quoteBody(rooms, pax)).expect(200)).body.data;
    expect(await q(1, 1)).toMatchObject({ nights: 3, perRoom: [{ guests: 1, ratePerNight: 1500 }], amount: 4500 });
    expect(await q(1, 2)).toMatchObject({ perRoom: [{ guests: 2, ratePerNight: 1800 }], amount: 5400 });
    expect(await q(1, 4)).toMatchObject({ perRoom: [{ guests: 4, ratePerNight: 2600 }], amount: 7800 }); // 1800 + 2 × 400
    expect(await q(2, 5)).toMatchObject({ perRoom: [{ guests: 3, ratePerNight: 2200 }, { guests: 2, ratePerNight: 1800 }], amount: 12000 });
    expect((await ctx.api().post(`${V1}/public/bookings/quote`).send(quoteBody(2, 9)).expect(400)).body.code).toBe('TOO_MANY_GUESTS');
    expect((await ctx.api().post(`${V1}/public/bookings/quote`).send(quoteBody(3, 2)).expect(400)).body.code).toBe('TOO_FEW_GUESTS');
  });

  it('bookings are priced with the same function and keep their per-room rates', async () => {
    await ctx.model('OtpChallenge').deleteMany({});
    await ctx.api().post(`${V1}/auth/guest/request-otp`).send({ phone: '9844400001' }).expect(200);
    const token = (await ctx.api().post(`${V1}/auth/guest/verify-otp`).send({ phone: '9844400001', otp: lastOtp }).expect(200)).body.data.accessToken;
    const quote = (await ctx.api().post(`${V1}/guest/bookings/quote`).set(bearer(token)).send(quoteBody(2, 5)).expect(200)).body.data;
    const booked = (await ctx.api().post(`${V1}/guest/bookings`).set(bearer(token))
      .send({ guestName: 'Family', phone: '9844400001', ...quoteBody(2, 5) }).expect(201)).body.data.booking;
    expect(booked.amount).toBe(quote.amount);
    expect(booked).toMatchObject({ nights: 3, status: 'REQUESTED' });
    expect(booked.rooms).toEqual([
      expect.objectContaining({ stayId: null, roomType: 'AC Family', guests: 3, rate: 2200, lineId: expect.any(String) }),
      expect.objectContaining({ stayId: null, roomType: 'AC Family', guests: 2, rate: 1800 }),
    ]);
    await ctx.api().post(`${V1}/guest/bookings`).set(bearer(token)).send({ guestName: 'Too many', phone: '9844400001', ...quoteBody(1, 5) }).expect(400);

    // Front desk: priced on the server whatever amount is sent; an OTA keeps its own amount.
    const desk = (await ctx.api().post(`${V1}/bookings`).set(bearer(ctx.token.STAFF))
      .send({ source: 'Walk-in', guestName: 'Desk', phone: '9844400002', ...quoteBody(1, 3), amount: '1.00' }).expect(201)).body.data;
    expect(desk).toMatchObject({ amount: 6600, roomLines: [{ guests: 3, rate: 2200 }] });
    const ota = (await ctx.api().post(`${V1}/bookings`).set(bearer(ctx.token.STAFF))
      .send({ source: 'MakeMyTrip', ref: 'MMT-77', guestName: 'OTA', phone: '9844400003', ...quoteBody(1, 1), amount: '4000.00' }).expect(201)).body.data;
    expect(ota).toMatchObject({ amount: 4000, roomLines: [{ guests: 1, rate: 1500 }] });

    // A later price rise doesn't touch the booking: check-in charges the booked rate.
    await ctx.api().patch(`${V1}/room-types/${typeId}`).set(owner()).send({ doubleRate: '2500', additionalGuestRate: '900' }).expect(200);
    const bookingDoc = (await ctx.model('Booking').findById(booked.id).lean()) as any;
    expect(bookingDoc.amount.toString()).toBe('12000.00');
    const roomId = async (n: string) => String(((await ctx.model('Room').findOne({ number: n }).lean()) as any)._id);
    // First room: no guest count given, so the booked line (3 guests at 2200) applies.
    const first = (await ctx.api().post(`${V1}/stays`).set(bearer(ctx.token.STAFF))
      .send({ roomId: await roomId('601'), guestName: 'Family', phone: '9844400001', nights: 3, bookingId: booked.id }).expect(201)).body.data.stay;
    expect(first).toMatchObject({ guests: 3, rate: 2200 });
    // The desk changes the second room to 1 guest: priced from the booking's own price card.
    const second = (await ctx.api().post(`${V1}/stays`).set(bearer(ctx.token.STAFF))
      .send({ roomId: await roomId('602'), guestName: 'Family B', phone: '9844400001', nights: 3, bookingId: booked.id, guests: 1 }).expect(201)).body.data.stay;
    expect(second).toMatchObject({ guests: 1, rate: 1500 });
    const tariff = await ctx.model('FolioLine').find({ stayId: first.id, source: 'TARIFF' }).lean();
    expect(Number((tariff[0] as any).taxable.toString())).toBe(6600); // 2200 × 3, before GST

    const mine = (await ctx.api().get(`${V1}/guest/bookings`).set(bearer(token))).body.data.bookings.find((b: any) => b.id === booked.id);
    expect(mine.rooms.map((r: any) => [r.roomNumber, r.guests, r.rate])).toEqual([['601', 3, 2200], ['602', 1, 1500]]);
  });

  it('one booking can mix room types, each room with its own guests and price', async () => {
    const standard = (await ctx.api().get(`${V1}/public/room-types`)).body.data.find((t: any) => t.name === 'Standard'); // 1900 after the PATCH above, sleeps 2
    const lines = [{ roomTypeId: typeId, guests: 2 }, { roomTypeId: typeId, guests: 3 }, { roomTypeId: standard.id, guests: 1 }];
    const body = { rooms: lines, arrivalDate: day(20), departureDate: day(22) };
    const quote = (await ctx.api().post(`${V1}/public/bookings/quote`).send(body).expect(200)).body.data;
    // AC Family is now double 2500, +900 per extra guest (changed in the test above).
    expect(quote).toMatchObject({ nights: 2, amount: (2500 + 3400 + 1900) * 2 });
    expect(quote.rooms.map((r: any) => [r.roomType, r.guests, r.ratePerNight])).toEqual([['AC Family', 2, 2500], ['AC Family', 3, 3400], ['Standard', 1, 1900]]);

    const bad = (b: object) => ctx.api().post(`${V1}/public/bookings/quote`).send({ ...body, ...b }).expect(400).then((r) => r.body);
    expect(await bad({ rooms: [{ roomTypeId: standard.id, guests: 3 }] })).toMatchObject({ code: 'TOO_MANY_GUESTS', message: 'Standard sleeps 2 — max 2 guests per room' });
    expect((await bad({ pax: 7 })).code).toBe('PAX_MISMATCH');
    expect((await bad({ rooms: Array.from({ length: 11 }, () => ({ roomTypeId: typeId, guests: 1 })) })).message).toBe('For bulk booking, please contact the front desk.');
    expect((await bad({ departureDate: day(60) })).code).toBe('INVALID_DATES');
    await bad({ rooms: [{ roomTypeId: typeId, guests: 0 }] });
    await bad({ rooms: [] });

    // Front desk books it; checking in a Standard room takes the Standard line, wherever it sits.
    const booking = (await ctx.api().post(`${V1}/bookings`).set(bearer(ctx.token.STAFF))
      .send({ source: 'Walk-in', guestName: 'Mixed', phone: '9844400010', pax: 6, ...body }).expect(201)).body.data;
    expect(booking).toMatchObject({ rooms: 3, pax: 6, amount: (2500 + 3400 + 1900) * 2 });
    const std = String(((await ctx.model('Room').findOne({ roomTypeId: standard.id, status: 'VACANT' }).lean()) as any)._id);
    const stay = (await ctx.api().post(`${V1}/stays`).set(bearer(ctx.token.STAFF)).send({ roomId: std, guestName: 'Mixed C', phone: '9844400010', nights: 2, bookingId: booking.id }).expect(201)).body.data.stay;
    expect(stay).toMatchObject({ guests: 1, rate: 1900 });
    const saved = (await ctx.model('Booking').findById(booking.id).lean()) as any;
    expect(saved.roomLines.map((l: any) => (l.stayId ? String(l.stayId) : null))).toEqual([null, null, stay.id]);
  });
});
