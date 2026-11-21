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
const day = (n: number) => {
  const d = new Date(`${ctx.today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
let seq = 0;
const create = async (amount: string, extra: object = {}) =>
  (await ctx.api().post(`${V1}/online-orders`).set(mgr())
    .send({ businessDate: ctx.today, platform: 'Swiggy', orderId: `SW-${++seq}`, items: [{ name: 'Thali', qty: 2, price: '250.00' }], amount, ...extra })
    .expect(201)).body.data;
const setStatus = (id: string, status: string, as = mgr()) => ctx.api().patch(`${V1}/online-orders/${id}`).set(as).send({ status });
const daybook = async (date = ctx.today) => (await ctx.api().get(`${V1}/daybook`).query({ date }).set(admin()).expect(200)).body.data;
const summary = async (from: string, to: string) => (await ctx.api().get(`${V1}/reports/summary`).query({ from, to }).set(admin()).expect(200)).body.data;

describe('Online orders', () => {
  it('posts the order value to the day book once, as a BANK receipt; commissionPct is ignored', async () => {
    const before = await daybook();
    const order = await create('500.00', { commissionPct: '20' });
    expect(order).toMatchObject({ platform: 'Swiggy', amount: 500, status: 'PREPARING', businessDate: ctx.today, payout: null, commissionPct: null });
    expect(order.time).toMatch(/^\d{2}:\d{2}$/);
    expect((await daybook()).credits).toBe(before.credits + 500);
    expect(await ctx.model('DayRegisterEntry').countDocuments({ _id: order.entryId, source: 'ONLINE', mode: 'BANK', dc: 'CREDIT' })).toBe(1);

    const listed = (await ctx.api().get(`${V1}/online-orders`).set(mgr()).expect(200)).body.data.find((o: any) => o.id === order.id);
    expect(listed).toMatchObject({ id: order.id, platform: 'Swiggy', orderId: order.orderId, amount: 500, status: 'PREPARING', time: order.time, businessDate: ctx.today });
    expect(listed.items).toEqual([expect.objectContaining({ name: 'Thali', qty: 2, price: 250 })]);
  });

  it('a manager moves it forward, steps may be skipped; delivered is final (409 ORDER_CLOSED); no money moves', async () => {
    const order = await create('300.00');
    const before = await daybook();
    expect((await setStatus(order.id, 'PICKED_UP').expect(200)).body.data.status).toBe('PICKED_UP');
    expect((await setStatus(order.id, 'PREPARING').expect(409)).body.code).toBe('INVALID_STATUS_CHANGE');
    await setStatus(order.id, 'DELIVERED').expect(200);
    expect((await daybook()).credits).toBe(before.credits);
    for (const s of ['CANCELLED', 'PICKED_UP', 'DELIVERED']) expect((await setStatus(order.id, s).expect(409)).body.code).toBe('ORDER_CLOSED');

    const skip = await create('120.00');
    await setStatus(skip.id, 'DELIVERED').expect(200);
    await setStatus(skip.id, 'NOPE').expect(400);
    const log = (await ctx.model('AuditLog').findOne({ action: 'ONLINE_ORDER_STATUS', 'details.orderId': order.id, 'details.to': 'DELIVERED' }).lean()) as any;
    expect(log.details).toMatchObject({ from: 'PICKED_UP', to: 'DELIVERED' });
    expect(log.userId).toBeTruthy();
  });

  it('cancelling voids the receipt: day book, sales and food orders drop by the order', async () => {
    const order = await create('450.00');
    const book = await daybook();
    const sum = await summary(ctx.today, ctx.today);
    await setStatus(order.id, 'CANCELLED').expect(200);
    expect((await daybook()).credits).toBe(book.credits - 450);
    const after = await summary(ctx.today, ctx.today);
    expect(Number(after.totalSales)).toBe(Number(sum.totalSales) - 450);
    expect(Number(after.foodSales)).toBe(Number(sum.foodSales) - 450);
    expect(after.totalFoodOrders).toBe(sum.totalFoodOrders - 1);
    expect(await ctx.model('DayRegisterEntry').countDocuments({ _id: order.entryId })).toBe(0);
    expect((await setStatus(order.id, 'PREPARING').expect(409)).body.code).toBe('ORDER_CLOSED');
  });

  it('an order from a closed day is reversed on the open day, linked to the original receipt', async () => {
    const order = await create('800.00');
    await ctx.api().post(`${V1}/business-day/close`).set(admin()).send({ businessDate: ctx.today, countedCash: '0', note: 'test', time: '23:00' }).expect(200);
    const closed = await daybook();
    const last = (await ctx.api().get(`${V1}/business-day/current`).set(admin()).expect(200)).body.data.lastClosingBalance;
    await ctx.api().post(`${V1}/business-day/start`).set(admin()).send({ businessDate: day(1), openingBalance: String(last), time: '08:00' }).expect(200);
    const sales = Number((await summary(ctx.today, day(1))).totalSales);

    await setStatus(order.id, 'CANCELLED').expect(200);
    expect((await daybook()).credits).toBe(closed.credits); // the closed day is untouched
    const reversal = (await ctx.model('DayRegisterEntry').findOne({ reversalOf: order.entryId }).lean()) as any;
    expect(reversal).toMatchObject({ businessDate: day(1), dc: 'DEBIT', mode: 'BANK', source: 'ONLINE', type: 'Online order cancelled' });
    expect((await daybook(day(1))).debits).toBe(800);
    expect(Number((await summary(ctx.today, day(1))).totalSales)).toBe(sales - 800);
  });
});
