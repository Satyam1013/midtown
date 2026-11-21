import { bearer, bootApp, checkIn, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;
let stayId: string;
let waiter: any;

beforeAll(async () => {
  ctx = await bootApp();
  stayId = (await checkIn(ctx, '101', 'Room Guest', '9866000001')).id;
  waiter = (await ctx.api().get(`${V1}/staff`).set(bearer(ctx.token.STAFF)).expect(200)).body.data[0];
});

afterAll(async () => {
  await ctx.app.close();
});

const admin = () => bearer(ctx.token.ADMIN);
const mgr = () => bearer(ctx.token.MANAGER);
const staff = () => bearer(ctx.token.STAFF);
const yesterday = () => {
  const d = new Date(`${ctx.today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const place = async (body: object) =>
  (await ctx.api().post(`${V1}/kots`).set(staff()).send({ items: [{ menuItemId: await ctx.menuId('Veg Thali'), qty: 2 }], ...body }).expect(201)).body.data.kot;
const move = (id: string, status: string, as = mgr()) => ctx.api().patch(`${V1}/kots/${id}`).set(as).send({ status });
const folio = async () => Number((await ctx.api().get(`${V1}/stays/${stayId}/bill`).set(staff()).expect(200)).body.data.balance);
const summary = async () => (await ctx.api().get(`${V1}/reports/summary`).set(admin()).expect(200)).body.data;

describe('GET /kots', () => {
  it('rows carry item names and prices, room, waiter and a display number; newest first; filters', async () => {
    const room = await place({ stayId, billTo: 'ROOM', waiterId: waiter.id });
    const table = await place({ tableLabel: 'Table 4', billTo: 'PAY_NOW' });
    const res = (await ctx.api().get(`${V1}/kots`).set(mgr()).expect(200)).body;
    expect(res.data.map((k: any) => k.id).slice(0, 2)).toEqual([table.id, room.id]);
    const row = res.data.find((k: any) => k.id === room.id);
    expect(row).toMatchObject({
      stayId, roomNumber: '101', tableLabel: null, billTo: 'ROOM', waiterName: waiter.name, status: 'PLACED',
      displayNumber: `K-${String(room.number).padStart(4, '0')}`, businessDate: ctx.today,
      items: [expect.objectContaining({ name: 'Veg Thali', qty: 2, price: 220 })],
    });
    expect(row.total).toBeGreaterThan(0);
    expect(row.createdAt).toBeTruthy();

    const byStay = (await ctx.api().get(`${V1}/kots`).query({ stayId }).set(mgr()).expect(200)).body.data;
    expect(byStay.every((k: any) => k.stayId === stayId)).toBe(true);
    expect((await ctx.api().get(`${V1}/kots`).query({ status: 'PLACED', limit: 1 }).set(mgr()).expect(200)).body).toMatchObject({ data: [expect.anything()], meta: { limit: 1, total: 2 } });
    expect((await ctx.api().get(`${V1}/kots`).query({ date: yesterday() }).set(mgr()).expect(403)).body.code).toBe('PAST_DATE_RESTRICTED');
    expect((await ctx.api().get(`${V1}/kots`).query({ date: yesterday() }).set(admin()).expect(200)).body.data).toEqual([]);
  });
});

describe('PATCH /kots/:id', () => {
  it('moves forward, steps may be skipped; never back; SERVED is final (409 KOT_CLOSED); audited', async () => {
    const k = await place({ tableLabel: 'T1', billTo: 'PAY_NOW' });
    expect((await move(k.id, 'READY').expect(200)).body.data.status).toBe('READY');
    expect((await move(k.id, 'PREPARING').expect(409)).body.code).toBe('INVALID_KOT_STATUS');
    await move(k.id, 'SERVED').expect(200);
    for (const s of ['CANCELLED', 'READY']) expect((await move(k.id, s).expect(409)).body.code).toBe('KOT_CLOSED');
    await move(k.id, 'DONE').expect(400);
    const log = (await ctx.model('AuditLog').findOne({ action: 'KOT_STATUS', 'details.kotId': k.id, 'details.to': 'SERVED' }).lean()) as any;
    expect(log.details).toMatchObject({ from: 'READY', to: 'SERVED' });
    // The older path still works for the kitchen app.
    const old = await place({ tableLabel: 'T2', billTo: 'PAY_NOW' });
    await ctx.api().patch(`${V1}/kots/${old.id}/status`).set(bearer(ctx.token.KITCHEN)).send({ status: 'PREPARING' }).expect(200);
    await ctx.api().patch(`${V1}/kots/${old.id}`).set(bearer(ctx.token.KITCHEN)).send({ status: 'CANCELLED' }).expect(403);
  });

  it('cancelling a ROOM KOT takes its charge off the folio and out of the reports', async () => {
    const k = await place({ stayId, billTo: 'ROOM' });
    const before = await folio();
    const report = await summary();
    await move(k.id, 'PREPARING').expect(200);
    await move(k.id, 'CANCELLED').expect(200);
    expect(await folio()).toBeCloseTo(before - k.total);
    const after = await summary();
    expect(after.totalFoodOrders).toBe(report.totalFoodOrders - 1);
    expect(Number(after.foodSales)).toBeCloseTo(Number(report.foodSales) - k.total);
    expect((await move(k.id, 'PREPARING').expect(409)).body.code).toBe('KOT_CLOSED');
  });

  it('a paid PAY_NOW KOT is 409 KOT_SETTLED; an unpaid one cancels and can no longer be settled', async () => {
    const paid = await place({ tableLabel: 'T5', billTo: 'PAY_NOW' });
    await ctx.api().post(`${V1}/bills/settle`).set(staff()).send({ kotIds: [paid.id], mode: 'CASH', time: '13:00' }).expect(200);
    expect((await move(paid.id, 'CANCELLED').expect(409)).body.code).toBe('KOT_SETTLED');
    const unpaid = await place({ tableLabel: 'T6', billTo: 'PAY_NOW' });
    await move(unpaid.id, 'CANCELLED').expect(200);
    expect((await ctx.api().post(`${V1}/bills/settle`).set(staff()).send({ kotIds: [unpaid.id], mode: 'CASH', time: '13:00' }).expect(409)).body.code).toBe('KOT_CANCELLED');
  });

  it('a ROOM KOT of a checked-out stay is 409 KOT_BILLED', async () => {
    const other = await checkIn(ctx, '102', 'Leaving', '9866000002');
    const k = await place({ stayId: other.id, billTo: 'ROOM' });
    await ctx.api().post(`${V1}/stays/${other.id}/checkout`).set(staff()).send({}).expect(200);
    expect((await move(k.id, 'CANCELLED').expect(409)).body.code).toBe('KOT_BILLED');
  });
});
