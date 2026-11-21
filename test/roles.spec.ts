import { JwtService } from '@nestjs/jwt';
import { bearer, bootApp, checkIn, Ctx } from './helpers';

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
const yesterday = () => {
  const d = new Date(`${ctx.today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

describe('Role in auth', () => {
  it('login returns the role and puts it in the token', async () => {
    const owner = await ctx.model('User').findOne({ role: 'ADMIN' }).lean() as any;
    const res = await ctx.api().post(`${V1}/auth/staff/login`).send({ identifier: owner.phone, password: 'password-for-tests' }).expect(200);
    expect(res.body.data.user).toMatchObject({ id: String(owner._id), name: owner.name, role: 'ADMIN' });
    const claims = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ typ: 'staff', sub: String(owner._id), role: 'ADMIN' });
  });

  it('a tampered, forged or role-less token is rejected; the role never comes from the body', async () => {
    const manager = await ctx.model('User').findOne({ role: 'MANAGER' }).select('+tokenVersion').lean() as any;
    const jwt = ctx.app.get(JwtService);
    const sign = (claims: object, secret = process.env.JWT_ACCESS_SECRET!) => jwt.signAsync(claims, { secret, expiresIn: '1h' });
    const base = { typ: 'staff', sub: String(manager._id), ver: manager.tokenVersion ?? 0 };

    // Payload edited to ADMIN, signature left as it was.
    const [h, , s] = ctx.token.MANAGER.split('.');
    const edited = Buffer.from(JSON.stringify({ ...base, role: 'ADMIN' })).toString('base64url');
    const tampered = [h, edited, s].join('.');
    // Signed with another key; signed correctly but without a role; signed with a role the user doesn't have.
    const wrongKey = await sign({ ...base, role: 'ADMIN' }, 'not-the-secret-not-the-secret-not-the');
    const noRole = await sign(base);
    const wrongRole = await sign({ ...base, role: 'ADMIN' });

    for (const t of [tampered, wrongKey, noRole, wrongRole]) {
      const res = await ctx.api().get(`${V1}/rooms`).set(bearer(t)).expect(401);
      expect(res.body.code).toBe('INVALID_TOKEN');
    }
    await ctx.api().get(`${V1}/rooms`).expect(401);

    const roomId = await ctx.roomId('101');
    const res = await ctx.api().patch(`${V1}/rooms/${roomId}`).set(mgr()).send({ role: 'ADMIN', blurb: 'x' }).expect(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', message: 'Admin access required' });
  });
});

describe('Rooms: edit, images and create are ADMIN only', () => {
  it('MANAGER gets 403 FORBIDDEN; ADMIN gets 200 / 201', async () => {
    const id = await ctx.roomId('102');
    const forbidden = [
      ctx.api().patch(`${V1}/rooms/${id}`).set(mgr()).send({ singleRate: '900', doubleRate: '1200' }),
      ctx.api().patch(`${V1}/rooms/${id}`).set(mgr()).send({ blurb: 'Sea view' }),
      ctx.api().delete(`${V1}/rooms/${id}`).set(mgr()),
      ctx.api().post(`${V1}/rooms`).set(mgr()).send({ number: '901', floor: 9, category: 'AC', roomType: 'AC Standard', singleRate: '1000', doubleRate: '1500' }),
      ctx.api().post(`${V1}/rooms/${id}/images`).set(mgr()).attach('file', Buffer.from('x'), 'a.png'),
      ctx.api().delete(`${V1}/rooms/${id}/images/${id}`).set(mgr()),
      ctx.api().patch(`${V1}/room-types/${id}`).set(mgr()).send({ tariff: '1000' }),
      ctx.api().post(`${V1}/room-types`).set(mgr()).send({}),
    ];
    for (const res of await Promise.all(forbidden)) {
      expect([res.status, res.body.code, res.body.message]).toEqual([403, 'FORBIDDEN', 'Admin access required']);
    }

    await ctx.api().patch(`${V1}/rooms/${id}`).set(admin()).send({ singleRate: '900', doubleRate: '1200', blurb: 'Sea view' }).expect(200);
    await ctx.api().post(`${V1}/rooms`).set(admin()).send({ number: '901', floor: 9, category: 'AC', roomType: 'AC Standard', singleRate: '1000', doubleRate: '1500' }).expect(201);
  });

  it('MANAGER still reads rooms, sets status and marks all clean', async () => {
    const id = await ctx.roomId('103');
    await ctx.api().get(`${V1}/rooms`).set(mgr()).expect(200);
    await ctx.api().get(`${V1}/rooms/${id}`).set(mgr()).expect(200);
    await ctx.api().patch(`${V1}/rooms/${id}/status`).set(mgr()).send({ status: 'OOO' }).expect(200);
    await ctx.api().patch(`${V1}/rooms/${id}/status`).set(mgr()).send({ status: 'VACANT' }).expect(200);
    await ctx.api().post(`${V1}/rooms/mark-all-clean`).set(mgr()).expect(200);
  });
});

describe('DELETE /rooms/:id', () => {
  it('an occupied room is 409 ROOM_IN_USE and stays', async () => {
    await checkIn(ctx, '201', 'In House', '9822000001');
    const res = await ctx.api().delete(`${V1}/rooms/${await ctx.roomId('201')}`).set(admin()).expect(409);
    expect(res.body.code).toBe('ROOM_IN_USE');
    expect(await ctx.model('Room').countDocuments({ number: '201' })).toBe(1);
  });

  it('a room with history is soft-deleted: hidden from lists, still named in old records', async () => {
    const stay = await checkIn(ctx, '202', 'Past Guest', '9822000002');
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(bearer(ctx.token.STAFF)).send({}).expect(200);
    const id = await ctx.roomId('202');
    const res = await ctx.api().delete(`${V1}/rooms/${id}`).set(admin()).expect(200);
    expect(res.body.data).toMatchObject({ id, number: '202', deleted: true, soft: true });

    const list = (await ctx.api().get(`${V1}/rooms`).set(mgr()).expect(200)).body.data;
    expect(list.map((r: any) => r.number)).not.toContain('202');
    await ctx.api().post(`${V1}/stays`).set(bearer(ctx.token.STAFF)).send({ roomId: id, guestName: 'New', phone: '9822000003', nights: 1 }).expect(404);
    expect(await ctx.model('Room').countDocuments({ _id: id }).setOptions({ withDeleted: true })).toBe(1);

    // The old stay and the register still show the room number.
    const old = (await ctx.api().get(`${V1}/stays/${stay.id}/bill`).set(mgr()).expect(200)).body.data;
    expect(JSON.stringify(old)).toContain('"202"');
    const register = (await ctx.api().get(`${V1}/daybook/register`).query({ date: ctx.today }).set(mgr()).expect(200)).body.data;
    expect(register.some((l: any) => l.roomNumber === '202')).toBe(true);

    // The number is never reused.
    await ctx.api().post(`${V1}/rooms`).set(admin()).send({ number: '202', floor: 2, category: 'AC', roomType: 'AC Standard', singleRate: '1000', doubleRate: '1500' }).expect(409);

    const log = await ctx.model('AuditLog').findOne({ action: 'ROOM_DELETE', 'details.number': '202' }).lean() as any;
    expect(log).toMatchObject({ details: { roomId: id, number: '202', mode: 'SOFT' } });
    expect(String(log.userId)).toBe(String((await ctx.model('User').findOne({ role: 'ADMIN' }).lean() as any)._id));
    expect(log.createdAt).toBeInstanceOf(Date);
  });

  it('a room without history is removed outright', async () => {
    const created = (await ctx.api().post(`${V1}/rooms`).set(admin()).send({ number: '902', floor: 9, category: 'AC', roomType: 'AC Standard', singleRate: '1000', doubleRate: '1500' }).expect(201)).body.data;
    const res = await ctx.api().delete(`${V1}/rooms/${created.id}`).set(admin()).expect(200);
    expect(res.body.data).toMatchObject({ number: '902', deleted: true, soft: false });
    expect(await ctx.model('Room').countDocuments({ _id: created.id }).setOptions({ withDeleted: true })).toBe(0);
    expect(await ctx.model('AuditLog').countDocuments({ action: 'ROOM_DELETE', 'details.number': '902', 'details.mode': 'HARD' })).toBe(1);
    await ctx.api().delete(`${V1}/rooms/${created.id}`).set(admin()).expect(404);
  });
});

describe('Day book and cash: non-admins see only the open day', () => {
  const reads = (q: Record<string, string>) => [
    [`${V1}/daybook`, q],
    [`${V1}/daybook/register`, q],
    [`${V1}/entries`, q],
    [`${V1}/expenses`, q],
    [`${V1}/expenses/summary`, q],
    [`${V1}/invoices`, q],
    [`${V1}/online-orders`, q],
    [`${V1}/reports/daily`, q],
    [`${V1}/reports/cash`, q],
  ] as const;

  it('MANAGER: a past date is 403 PAST_DATE_RESTRICTED, the open day is 200', async () => {
    for (const [url, q] of reads({ date: yesterday() })) {
      const res = await ctx.api().get(url).query(q).set(mgr());
      expect([url, res.status, res.body.code]).toEqual([url, 403, 'PAST_DATE_RESTRICTED']);
    }
    for (const [url, q] of reads({ date: ctx.today })) {
      const res = await ctx.api().get(url).query(q).set(mgr());
      expect([url, res.status]).toEqual([url, 200]);
    }
    const range = (from: string, to: string) => ctx.api().get(`${V1}/daybook/shortages`).query({ from, to }).set(mgr());
    expect((await range(yesterday(), ctx.today).expect(403)).body.code).toBe('PAST_DATE_RESTRICTED');
    await range(ctx.today, ctx.today).expect(200);
    // STAFF is held to the same rule.
    await ctx.api().get(`${V1}/entries`).query({ date: yesterday() }).set(bearer(ctx.token.STAFF)).expect(403);
  });

  it('MANAGER: no date means the open day, also for "all dates" lists', async () => {
    expect((await ctx.api().get(`${V1}/daybook`).set(mgr()).expect(200)).body.data.businessDate).toBe(ctx.today);
    await ctx.api().get(`${V1}/daybook/shortages`).set(mgr()).expect(200);
    const by = (await ctx.model('User').findOne({ role: 'ADMIN' }).lean() as any)._id;
    await ctx.model('Expense').create({ createdByUserId: by, businessDate: yesterday(), time: '09:00', head: 'Fuel', vendor: 'Old', mode: 'CASH', amount: '50', narration: '' });
    await ctx.api().post(`${V1}/expenses`).set(mgr()).send({ head: 'Fuel', mode: 'CASH', amount: '10.00' }).expect(201);
    const mine = (await ctx.api().get(`${V1}/expenses`).set(mgr()).expect(200)).body.data;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x: any) => x.businessDate === ctx.today)).toBe(true);
    const all = (await ctx.api().get(`${V1}/expenses`).set(admin()).expect(200)).body.data;
    expect(all.some((x: any) => x.businessDate === yesterday())).toBe(true);
  });

  it('ADMIN reads any date', async () => {
    for (const [url, q] of reads({ date: yesterday() })) {
      const res = await ctx.api().get(url).query(q).set(admin());
      expect([url, res.status]).toEqual([url, 200]);
    }
    await ctx.api().get(`${V1}/daybook/shortages`).query({ from: yesterday(), to: ctx.today }).set(admin()).expect(200);
  });

  it('MANAGER cannot change past-day data; the open day is fine', async () => {
    const roomId = await ctx.roomId('101');
    const entry = { time: '10:00', roomId, guestName: 'Old', phone: '9811100000', vehicle: '', type: 'Other receipt', mode: 'CASH', dc: 'CREDIT', amount: '100.00', narration: '' };
    const by = (await ctx.model('User').findOne({ role: 'ADMIN' }).lean() as any)._id;
    const past = await ctx.model('DayRegisterEntry').create({ ...entry, businessDate: yesterday(), source: 'MANUAL', createdByUserId: by });
    for (const res of await Promise.all([
      ctx.api().patch(`${V1}/entries/${past._id}`).set(mgr()).send({ narration: 'edit' }),
      ctx.api().delete(`${V1}/entries/${past._id}`).set(mgr()),
      ctx.api().patch(`${V1}/daybook/opening`).set(mgr()).send({ businessDate: yesterday(), openingBalance: '10.00' }),
      ctx.api().post(`${V1}/invoices`).set(mgr()).send({ businessDate: yesterday(), party: 'X', partyGstin: null, stayId: null, lines: [{ description: 'Room', kind: 'ROOM', qty: 1, rate: '100.00' }] }),
    ])) {
      expect([res.status, res.body.code]).toEqual([403, 'PAST_DATE_RESTRICTED']);
    }
    const today = (await ctx.api().post(`${V1}/entries`).set(mgr()).send(entry).expect(201)).body.data;
    await ctx.api().patch(`${V1}/entries/${today.id}`).set(mgr()).send({ narration: 'fixed' }).expect(200);
    await ctx.api().patch(`${V1}/daybook/opening`).set(mgr()).send({ businessDate: ctx.today, openingBalance: '0.00' }).expect(200);
  });

  it('with no day open a manager gets empty data; ADMIN still sees everything', async () => {
    await ctx.api().post(`${V1}/business-day/close`).set(admin()).send({ businessDate: ctx.today, countedCash: '0', note: 'test close', time: '23:00' }).expect(200);
    expect((await ctx.api().get(`${V1}/daybook`).set(mgr()).expect(200)).body.data).toBeNull();
    expect((await ctx.api().get(`${V1}/entries`).query({ date: ctx.today }).set(mgr()).expect(200)).body.data).toEqual([]);
    expect((await ctx.api().get(`${V1}/daybook/register`).set(mgr()).expect(200)).body.data).toEqual([]);
    const expenses = (await ctx.api().get(`${V1}/expenses`).set(mgr()).expect(200)).body;
    expect([expenses.data, expenses.meta.total]).toEqual([[], 0]);
    expect((await ctx.api().get(`${V1}/reports/daily`).set(mgr()).expect(200)).body.data.rows).toEqual([]);
    expect((await ctx.api().get(`${V1}/entries`).query({ date: ctx.today }).set(admin()).expect(200)).body.data.length).toBeGreaterThan(0);
  });
});
