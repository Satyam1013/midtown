import { bearer, bootApp, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;
const rooms: Record<string, string> = {};

beforeAll(async () => {
  ctx = await bootApp();
});

afterAll(async () => {
  await ctx.app.close();
});

const mgr = () => bearer(ctx.token.MANAGER);
const staff = () => bearer(ctx.token.STAFF);
const blank = { beds: '', blurb: '', size: '', sizeSqft: null, sleeps: null, additionalGuestPrice: null };
const create = (number: string, extra: object) =>
  ctx.api().post(`${V1}/rooms`).set(bearer(ctx.token.ADMIN)).send({ number, floor: 7, category: 'AC', roomType: 'AC Standard', singleRate: '1000', doubleRate: '1500', ...blank, ...extra });
const getRoom = async (n: string) => (await ctx.api().get(`${V1}/rooms/${rooms[n]}`).set(staff()).expect(200)).body.data;
const checkIn = (n: string, guests: number) =>
  ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId: rooms[n], guestName: `Guest ${n}`, phone: `98555007${n.slice(-2)}`, guests, nights: 2 });

describe('Room details', () => {
  it('create, read, and PATCH: missing leaves a field alone, null or "" clears it', async () => {
    const res = await create('701', { beds: '1 King bed', blurb: 'Quiet corner room', size: '22 sq m', sizeSqft: 240, sleeps: 3, additionalGuestPrice: 500 }).expect(201);
    rooms['701'] = res.body.data.id;
    expect(await getRoom('701')).toMatchObject({ beds: '1 King bed', blurb: 'Quiet corner room', size: '22 sq m', sizeSqft: 240, sleeps: 3, additionalGuestPrice: 500 });
    await ctx.api().patch(`${V1}/rooms/${rooms['701']}`).set(bearer(ctx.token.ADMIN)).send({ blurb: 'Updated' }).expect(200);
    expect(await getRoom('701')).toMatchObject({ beds: '1 King bed', blurb: 'Updated', sleeps: 3, additionalGuestPrice: 500 });
    await ctx.api().patch(`${V1}/rooms/${rooms['701']}`).set(bearer(ctx.token.ADMIN)).send({ beds: '', sizeSqft: null }).expect(200);
    expect(await getRoom('701')).toMatchObject({ beds: '', sizeSqft: null, size: '22 sq m' });
    // The app's empty create body is fine and gives the old behaviour.
    rooms['702'] = (await create('702', {}).expect(201)).body.data.id;
    expect(await getRoom('702')).toMatchObject({ ...blank });
  });

  it('validates the fields', async () => {
    for (const bad of [{ sizeSqft: 0 }, { sleeps: 11 }, { sleeps: 2.5 }, { additionalGuestPrice: -1 }, { blurb: 'x'.repeat(501) }, { beds: 'x'.repeat(81) }]) {
      await ctx.api().patch(`${V1}/rooms/${rooms['702']}`).set(bearer(ctx.token.ADMIN)).send(bad).expect(400);
    }
    await ctx.api().patch(`${V1}/rooms/${rooms['702']}`).set(bearer(ctx.token.ADMIN)).send({ additionalGuestPrice: 0 }).expect(200);
    await ctx.api().patch(`${V1}/rooms/${rooms['702']}`).set(bearer(ctx.token.ADMIN)).send({ additionalGuestPrice: '250.50' }).expect(200);
    expect((await getRoom('702')).additionalGuestPrice).toBe(250.5);
    await ctx.api().patch(`${V1}/rooms/${rooms['702']}`).set(bearer(ctx.token.ADMIN)).send({ additionalGuestPrice: null }).expect(200);
    expect((await getRoom('702')).additionalGuestPrice).toBeNull();
  });
});

describe('Per-room extra guest price and capacity', () => {
  it('check-in uses the room\'s extra price; null means ₹300; sleeps is enforced with a clear message', async () => {
    // 701: double 1500, +500 per extra guest, sleeps 3.
    expect((await checkIn('701', 3).expect(201)).body.data.stay).toMatchObject({ guests: 3, rate: 2000 });
    // 702: no extra price set → hotel default ₹300, no sleeps → up to 4.
    const four = (await checkIn('702', 4).expect(201)).body.data.stay;
    expect(four).toMatchObject({ guests: 4, rate: 2100 }); // 1500 + 2 × 300
    await ctx.api().post(`${V1}/stays/${four.id}/checkout`).set(staff()).send({}).expect(200);
    await ctx.model('Room').updateOne({ _id: rooms['702'] }, { $set: { status: 'VACANT' } });
    await ctx.api().patch(`${V1}/rooms/${rooms['702']}`).set(bearer(ctx.token.ADMIN)).send({ sleeps: 2 }).expect(200);
    const res = await checkIn('702', 3).expect(400);
    expect(res.body).toMatchObject({ code: 'TOO_MANY_GUESTS', message: 'Room 702 sleeps at most 2 guests' });
  });

  it('a price change affects only future check-ins and added guests; running stays keep their rate', async () => {
    rooms['703'] = (await create('703', { sleeps: 4, additionalGuestPrice: 100 }).expect(201)).body.data.id;
    const stay = (await checkIn('703', 3).expect(201)).body.data.stay;
    expect(stay.rate).toBe(1600);
    await ctx.api().patch(`${V1}/rooms/${rooms['703']}`).set(bearer(ctx.token.ADMIN)).send({ additionalGuestPrice: 0 }).expect(200);
    const row = (await ctx.api().get(`${V1}/rooms`).set(staff())).body.data.find((r: any) => r.number === '703');
    expect(row.currentStay).toMatchObject({ rate: 1600, guests: 3 });
    // A guest added now is priced with the new (free) extra charge.
    const added = (await ctx.api().post(`${V1}/stays/${stay.id}/guests`).set(staff()).send({ guests: 4, businessDate: ctx.today }).expect(201)).body.data;
    expect(added.stay).toMatchObject({ guests: 4, rate: 1500 });
    // The room is full now.
    expect((await ctx.api().post(`${V1}/stays/${stay.id}/guests`).set(staff()).send({ guests: 5, businessDate: ctx.today }).expect(409)).body)
      .toMatchObject({ code: 'GUEST_LIMIT', message: 'Room 703 sleeps at most 4 guests' });
  });

  it('a shift prices with the target room and respects its capacity', async () => {
    rooms['704'] = (await create('704', { sleeps: 2 }).expect(201)).body.data.id;
    rooms['705'] = (await create('705', { additionalGuestPrice: 700 }).expect(201)).body.data.id;
    const stay = (await ctx.model('Stay').findOne({ roomId: rooms['701'], status: 'IN_HOUSE' }).lean()) as any; // 3 guests
    const shift = (to: string) => ctx.api().post(`${V1}/stays/${stay._id}/shift`).set(staff()).send({ toRoomId: rooms[to], guests: 3, businessDate: ctx.today, time: '12:00' });
    expect((await shift('704').expect(400)).body.message).toBe('Room 704 sleeps at most 2 guests');
    expect(((await ctx.model('Room').findById(rooms['704']).lean()) as any).status).toBe('VACANT');
    const moved = (await shift('705').expect(200)).body.data;
    expect(moved).toMatchObject({ rate: 2200 }); // 1500 + 700, the target room's price
  });

  it('guest room types show the details and the extra-guest price', async () => {
    const t = (await ctx.api().get(`${V1}/public/room-types`)).body.data.find((x: any) => x.name === 'Standard');
    expect(t).toEqual(expect.objectContaining({ beds: expect.any(String), blurb: expect.any(String), size: expect.any(String), sizeSqft: 180, sleeps: 2, additionalGuestPrice: 0 }));
  });
});
