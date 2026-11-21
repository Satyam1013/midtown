import { bearer, bootApp, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;

const admin = () => bearer(ctx.token.ADMIN);
const mgr = () => bearer(ctx.token.MANAGER);
const day = (n: number) => {
  const d = new Date(`${ctx.today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
let D1: string;
let D2: string;

beforeAll(async () => {
  ctx = await bootApp();
  D1 = day(-3);
  D2 = day(-2);
  const by = ((await ctx.model('User').findOne({ role: 'ADMIN' }).lean()) as any)._id;
  const room = await ctx.roomId('101');
  const entry = (businessDate: string, time: string, dc: string, amount: string, source: string, type: string, extra: object = {}) => ({
    businessDate, time, dc, amount, source, type, mode: 'CASH', guestName: `Guest ${time}`, narration: type, createdByUserId: by, ...extra,
  });
  await ctx.model('DayRegisterEntry').create([
    entry(D1, '09:00', 'CREDIT', '1000.00', 'CHECKIN', 'Check-in', { roomId: room }),
    entry(D1, '13:00', 'CREDIT', '500.00', 'RESTAURANT', 'Restaurant', { mode: 'UPI' }),
    entry(D2, '10:00', 'DEBIT', '200.00', 'REFUND', 'Refund', { roomId: room }),
    entry(D2, '11:00', 'CREDIT', '300.00', 'MANUAL', 'Other receipt'),
    entry(D2, '18:00', 'DEBIT', '150.00', 'EXPENSE_PAYMENT', 'Expense payment'),
  ]);
  await ctx.model('Expense').create([
    { businessDate: D1, time: '15:00', head: 'Fuel', vendor: 'Pump', mode: 'CASH', amount: '400.00', createdByUserId: by },
    { businessDate: D2, time: '12:00', head: 'Groceries', vendor: 'Mandi', mode: null, onCredit: true, amount: '1000.00', dueAmount: '1000.00', createdByUserId: by },
  ]);
  const kot = (number: number, businessDate: string, total: string) => ({
    number, businessDate, tableLabel: 'T1', items: [{ name: 'Tea', price: total, qty: 1 }], taxable: total, cgst: '0', sgst: '0', total, billTo: 'PAY_NOW', source: 'FRONT_DESK',
  });
  await ctx.model('Kot').create([kot(9001, D1, '210.00'), kot(9002, D2, '105.00')]);
  const order = (orderId: string, amount: string, status: string) => ({
    businessDate: D2, platform: 'Swiggy', orderId, items: [], amount, commissionPct: '0', payout: amount, status,
  });
  await ctx.model('OnlineOrder').create([order('S-1', '500.00', 'DELIVERED'), order('S-2', '999.00', 'CANCELLED')]);
});

afterAll(async () => {
  await ctx.app.close();
});

const summary = (q: object, as = admin()) => ctx.api().get(`${V1}/reports/summary`).query(q).set(as);
const entries = (q: object, as = admin()) => ctx.api().get(`${V1}/reports/entries`).query(q).set(as);

describe('GET /reports/summary', () => {
  it('totals match the seeded range', async () => {
    const res = (await summary({ from: D1, to: D2 }).expect(200)).body;
    const expected = { totalSales: '1800.00', totalGuests: 0, totalFoodOrders: 3, totalExpenses: '1400.00', foodSales: '815.00', totalWithdraw: '0.00', totalLaundry: '0.00' };
    expect(res.data).toEqual(expected);
    expect(res).toMatchObject(expected); // also at the top level
  });

  it('from == to is a single day', async () => {
    expect((await summary({ from: D1, to: D1 }).expect(200)).body.data).toEqual({
      totalSales: '1500.00', totalGuests: 0, totalFoodOrders: 1, totalExpenses: '400.00', foodSales: '210.00', totalWithdraw: '0.00', totalLaundry: '0.00',
    });
  });

  it('counts guests once per stay by check-in date, and KOTs placed today', async () => {
    const stay = (n: string, guests: number, phone: string) =>
      ctx.api().post(`${V1}/stays`).set(bearer(ctx.token.STAFF)).send({ roomId: n, guestName: `G${phone}`, phone, guests, nights: 1 }).expect(201);
    const a = (await stay(await ctx.roomId('102'), 2, '9833000001')).body.data.stay;
    await stay(await ctx.roomId('103'), 1, '9833000002');
    // 2 → 3 mid-stay: still one stay, counted at 3.
    await ctx.api().post(`${V1}/stays/${a.id}/guests`).set(bearer(ctx.token.STAFF)).send({ guests: 3, name: 'Third', businessDate: ctx.today, time: '12:00' }).expect(201);
    const guestsNow = ((await ctx.model('Stay').findById(a.id).lean()) as any).guests;
    expect(guestsNow).toBe(3);
    await ctx.api().post(`${V1}/kots`).set(bearer(ctx.token.STAFF))
      .send({ tableLabel: 'T9', billTo: 'PAY_NOW', items: [{ menuItemId: await ctx.menuId('Veg Thali'), qty: 1 }] }).expect(201);

    const res = (await summary({}, mgr()).expect(200)).body.data;
    expect(res.totalGuests).toBe(guestsNow + 1);
    expect(res.totalFoodOrders).toBe(1);
  });
});

describe('GET /reports/entries', () => {
  it('lists entries and expenses newest first; total and totals cover the full range', async () => {
    const res = (await entries({ from: D1, to: D2 }).expect(200)).body;
    expect(res).toMatchObject({ total: 7, page: 1, limit: 25, totals: { credit: '1800.00', debit: '750.00' } });
    expect(res.data.map((r: any) => `${r.businessDate} ${r.time}`)).toEqual([
      `${D2} 18:00`, `${D2} 12:00`, `${D2} 11:00`, `${D2} 10:00`, `${D1} 15:00`, `${D1} 13:00`, `${D1} 09:00`,
    ]);
    expect(res.data[6]).toMatchObject({ roomNumber: '101', guestName: 'Guest 09:00', type: 'Check-in', mode: 'CASH', dc: 'CREDIT', amount: '1000.00', source: 'CHECKIN' });
    expect(res.data[1]).toMatchObject({ source: 'EXPENSE', type: 'Groceries', guestName: 'Mandi', dc: 'DEBIT', amount: '1000.00', onCredit: true });
  });

  it('filters by category', async () => {
    const of = async (category: string) => (await entries({ from: D1, to: D2, category }).expect(200)).body;
    const room = await of('ROOM');
    expect(room.data.map((r: any) => r.source)).toEqual(['REFUND', 'CHECKIN']);
    expect(room.totals).toEqual({ credit: '1000.00', debit: '200.00' });
    expect((await of('FOOD')).data.map((r: any) => r.source)).toEqual(['RESTAURANT']);
    const exp = await of('EXPENSE');
    expect(exp.data.map((r: any) => r.source)).toEqual(['EXPENSE_PAYMENT', 'EXPENSE', 'EXPENSE']);
    expect(exp.totals).toEqual({ credit: '0.00', debit: '550.00' });
    expect((await of('OTHER')).data.map((r: any) => r.source)).toEqual(['MANUAL']);
    await entries({ from: D1, to: D2, category: 'BAR' }).expect(400);
  });

  it('paginates in the database', async () => {
    const res = (await entries({ from: D1, to: D2, page: 2, limit: 3 }).expect(200)).body;
    expect(res).toMatchObject({ total: 7, page: 2, limit: 3, totals: { credit: '1800.00', debit: '750.00' } });
    expect(res.data.map((r: any) => `${r.businessDate} ${r.time}`)).toEqual([`${D2} 10:00`, `${D1} 15:00`, `${D1} 13:00`]);
    expect((await entries({ from: D1, to: D2, page: 3, limit: 3 }).expect(200)).body.data).toHaveLength(1);
    await entries({ from: D1, to: D2, limit: 5000 }).expect(200);
    await entries({ from: D1, to: D2, limit: 5001 }).expect(400);
  });
});

describe('Roles and validation', () => {
  it('MANAGER: 403 for a past date or a wider range, 200 for the open day', async () => {
    for (const q of [{ from: D1, to: D1 }, { from: D1, to: ctx.today }, { from: ctx.today, to: day(1) }, { from: D2 }]) {
      for (const call of [summary, entries]) {
        const res = await call(q, mgr());
        expect([res.status, res.body.code]).toEqual([403, 'PAST_DATE_RESTRICTED']);
      }
    }
    await summary({ from: ctx.today, to: ctx.today }, mgr()).expect(200);
    await entries({ from: ctx.today, to: ctx.today }, mgr()).expect(200);
    expect((await entries({}, mgr()).expect(200)).body.data.every((r: any) => r.businessDate === ctx.today)).toBe(true);
  });

  it('ADMIN: any range', async () => {
    await summary({ from: day(-365), to: ctx.today }).expect(200);
    await entries({ from: day(-365), to: ctx.today }).expect(200);
    await summary({ from: D1 }).expect(200);
  });

  it('invalid ranges are 400', async () => {
    const codes = async (q: object) => (await summary(q).expect(400)).body.code;
    expect(await codes({ from: D2, to: D1 })).toBe('INVALID_RANGE');
    expect(await codes({ from: '2026-02-30', to: '2026-03-01' })).toBe('INVALID_DATE');
    expect(await codes({ from: day(-366), to: ctx.today })).toBe('RANGE_TOO_LONG');
    await summary({ from: '18-11-2026' }).expect(400);
    await entries({ from: D2, to: D1 }).expect(400);
  });

  it('with no day open a manager gets zeros and an empty list', async () => {
    await ctx.api().post(`${V1}/business-day/close`).set(admin()).send({ businessDate: ctx.today, countedCash: '0', note: 'test close', time: '23:00' }).expect(200);
    expect((await summary({}, mgr()).expect(200)).body.data).toEqual({ totalSales: '0.00', totalGuests: 0, totalFoodOrders: 0, totalExpenses: '0.00', foodSales: '0.00', totalWithdraw: '0.00', totalLaundry: '0.00' });
    expect((await entries({}, mgr()).expect(200)).body).toMatchObject({ data: [], total: 0, totals: { credit: '0.00', debit: '0.00' } });
  });
});
