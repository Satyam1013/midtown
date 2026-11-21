import { bearer, bootApp, checkIn, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;
let stay: any;

beforeAll(async () => {
  ctx = await bootApp();
  stay = await checkIn(ctx, '101', 'Laundry Guest', '9899000001');
});

afterAll(async () => {
  await ctx.app.close();
});

const admin = () => bearer(ctx.token.ADMIN);
const mgr = () => bearer(ctx.token.MANAGER);
const staff = () => bearer(ctx.token.STAFF);
const shirts = [{ name: 'Shirt', service: 'WASH_IRON', qty: 2, price: '60.00' }];
const create = (body: object, as = mgr()) =>
  ctx.api().post(`${V1}/laundry/orders`).set(as).send({ source: 'STAFF', stayId: stay.id, billTo: 'ROOM', items: shirts, ...body });
const move = (id: string, status: string, extra: object = {}, as = mgr()) => ctx.api().patch(`${V1}/laundry/orders/${id}`).set(as).send({ status, ...extra });
const folio = async () => Number((await ctx.api().get(`${V1}/stays/${stay.id}/bill`).set(staff()).expect(200)).body.data.balance);
const daybook = async () => (await ctx.api().get(`${V1}/daybook`).query({ date: ctx.today }).set(admin()).expect(200)).body.data;
const request = async () => ctx.model('ServiceRequest').create({ stayId: stay.id, key: 'laundry', label: 'Laundry pickup', note: '2 shirts' });

describe('Laundry orders', () => {
  it('the server prices the order: items, +50% express, then 18% GST; a wrong client amount is 400', async () => {
    const o = (await create({ express: true, amount: '180.00' }).expect(201)).body.data;
    expect(o).toMatchObject({ number: expect.stringMatching(/^LND-\d{4}$/), status: 'REQUESTED', subtotal: 120, expressCharge: 60, amount: 180, gstPct: 18, cgst: 16.2, sgst: 16.2, total: 212.4, roomNumber: '101', guestName: 'Laundry Guest' });
    expect(o.items).toEqual([expect.objectContaining({ name: 'Shirt', service: 'WASH_IRON', qty: 2, price: 60 })]);
    expect((await create({ amount: '100.00' }).expect(400)).body.code).toBe('AMOUNT_MISMATCH');
    expect((await create({ items: [] }).expect(400)).body.code).toBe('VALIDATION_ERROR');
  });

  it('a walk-in needs a name and pays now; a room order needs a checked-in guest', async () => {
    expect((await create({ source: 'WALK_IN', stayId: null, billTo: 'PAY_NOW' }).expect(400)).body.code).toBe('GUEST_NAME_REQUIRED');
    expect((await create({ source: 'WALK_IN', stayId: null, guestName: 'Passer-by', billTo: 'ROOM' }).expect(400)).body.code).toBe('ROOM_BILL_NEEDS_STAY');
    await create({ source: 'WALK_IN', stayId: null, guestName: 'Passer-by', phone: '9899000002', billTo: 'PAY_NOW', mode: 'CASH' }).expect(201);
    expect((await create({ stayId: null }).expect(400)).body.code).toBe('STAY_REQUIRED');
    const out = await checkIn(ctx, '102', 'Gone', '9899000003');
    await ctx.api().post(`${V1}/stays/${out.id}/checkout`).set(staff()).send({}).expect(200);
    expect((await create({ stayId: out.id }).expect(400)).body.code).toBe('STAY_NOT_IN_HOUSE');
  });

  it('from a guest request: linked, request IN_PROGRESS, one live order per request; it follows the order to DONE', async () => {
    const req = await request();
    const o = (await create({ source: 'ROOM_REQUEST', stayId: undefined, requestId: String(req._id) }).expect(201)).body.data;
    expect(o).toMatchObject({ requestId: String(req._id), stayId: stay.id });
    let r = (await ctx.model('ServiceRequest').findById(req._id).lean()) as any;
    expect([r.status, String(r.laundryOrderId)]).toEqual(['IN_PROGRESS', o.id]);
    expect((await create({ source: 'ROOM_REQUEST', requestId: String(req._id) }).expect(409)).body.code).toBe('REQUEST_HAS_ORDER');
    const listed = (await ctx.api().get(`${V1}/service-requests`).set(staff()).expect(200)).body.data.find((x: any) => x.id === String(req._id));
    expect(listed).toMatchObject({ roomNumber: '101', guestName: 'Laundry Guest', note: '2 shirts', laundryOrderId: o.id });

    const before = await folio();
    await move(o.id, 'PICKED_UP').expect(200);
    await move(o.id, 'READY').expect(200);
    const delivered = (await move(o.id, 'DELIVERED').expect(200)).body.data;
    expect(delivered.deliveredAt).toBeTruthy();
    expect(await folio()).toBeCloseTo(before + 141.6); // 120 + 18% GST, once
    expect(await ctx.model('FolioLine').countDocuments({ laundryOrderId: o.id })).toBe(1);
    r = (await ctx.model('ServiceRequest').findById(req._id).lean()) as any;
    expect([r.status, r.remark]).toEqual(['DONE', 'Laundry delivered']);
    for (const s of ['CANCELLED', 'READY', 'DELIVERED']) expect((await move(o.id, s).expect(409)).body.code).toBe('ORDER_CLOSED');
    expect(await ctx.model('FolioLine').countDocuments({ laundryOrderId: o.id })).toBe(1);
  });

  it('PAY_NOW posts a Laundry credit on the open day; summary counts it in sales and totalLaundry', async () => {
    const book = await daybook();
    const sum = (await ctx.api().get(`${V1}/reports/summary`).set(admin()).expect(200)).body.data;
    const o = (await create({ billTo: 'PAY_NOW' }).expect(201)).body.data;
    expect((await move(o.id, 'DELIVERED').expect(400)).body.code).toBe('MODE_REQUIRED');
    await move(o.id, 'DELIVERED', { mode: 'UPI', time: '18:30' }).expect(200);
    expect((await daybook()).credits).toBeCloseTo(book.credits + 141.6);
    const line = (await ctx.api().get(`${V1}/daybook/register`).query({ date: ctx.today }).set(mgr()).expect(200)).body.data.find((l: any) => l.source === 'LAUNDRY');
    expect(line).toMatchObject({ type: 'Laundry', mode: 'UPI', dc: 'CREDIT', amount: 141.6, narration: o.number.replace(/^/, 'Laundry ') });
    const after = (await ctx.api().get(`${V1}/reports/summary`).set(admin()).expect(200)).body.data;
    expect(Number(after.totalSales)).toBeCloseTo(Number(sum.totalSales) + 141.6);
    expect(Number(after.totalLaundry)).toBeCloseTo(Number(sum.totalLaundry) + 141.6);
    expect(after.foodSales).toBe(sum.foodSales);
    const rows = (await ctx.api().get(`${V1}/reports/entries`).query({ category: 'LAUNDRY' }).set(admin()).expect(200)).body.data;
    expect(rows.map((x: any) => x.type)).toEqual(['Laundry']);
  });

  it('cancelling posts nothing and is final; a READY order needs ADMIN to cancel; never backwards', async () => {
    const book = await daybook();
    const f = await folio();
    const a = (await create({}).expect(201)).body.data;
    expect((await move(a.id, 'IN_PROCESS').expect(200)).body.data.status).toBe('IN_PROCESS');
    expect((await move(a.id, 'PICKED_UP').expect(409)).body.code).toBe('INVALID_STATUS_CHANGE');
    await move(a.id, 'CANCELLED').expect(200);
    expect((await move(a.id, 'DELIVERED').expect(409)).body.code).toBe('ORDER_CLOSED');
    const b = (await create({}).expect(201)).body.data;
    await move(b.id, 'READY').expect(200);
    expect((await move(b.id, 'CANCELLED').expect(403)).body.code).toBe('FORBIDDEN');
    await move(b.id, 'CANCELLED', {}, admin()).expect(200);
    expect((await daybook()).credits).toBe(book.credits);
    expect(await folio()).toBe(f);
    expect(await ctx.model('AuditLog').countDocuments({ action: 'LAUNDRY_ORDER', 'details.orderId': b.id })).toBe(3);
  });

  it('edits reprice an open order; a manager sees the open day plus older open orders', async () => {
    const o = (await create({}).expect(201)).body.data;
    const res = (await ctx.api().patch(`${V1}/laundry/orders/${o.id}`).set(mgr()).send({ items: [{ name: 'Saree', service: 'DRY_CLEAN', qty: 1, price: '250.00' }], express: true }).expect(200)).body.data;
    expect(res).toMatchObject({ amount: 375, total: 442.5, express: true, status: 'REQUESTED' });
    await ctx.model('LaundryOrder').updateOne({ _id: o.id }, { $set: { businessDate: '2026-01-01' } }); // from an earlier day, still open
    const done = (await create({}).expect(201)).body.data;
    await move(done.id, 'CANCELLED').expect(200);
    await ctx.model('LaundryOrder').updateOne({ _id: done.id }, { $set: { businessDate: '2026-01-01' } }); // closed and old
    const seen = (await ctx.api().get(`${V1}/laundry/orders`).set(mgr()).expect(200)).body.data.map((x: any) => x.id);
    expect(seen).toContain(o.id);
    expect(seen).not.toContain(done.id);
    expect((await ctx.api().get(`${V1}/laundry/orders`).query({ date: '2026-01-01' }).set(mgr()).expect(403)).body.code).toBe('PAST_DATE_RESTRICTED');
    expect((await ctx.api().get(`${V1}/laundry/orders`).query({ date: '2026-01-01' }).set(admin()).expect(200)).body.data.map((x: any) => x.id).sort()).toEqual([o.id, done.id].sort());
    await ctx.api().get(`${V1}/laundry/orders`).set(staff()).expect(403);
  });

  it('price list: built-in until an admin saves one; express % follows it', async () => {
    const list = (await ctx.api().get(`${V1}/laundry/prices`).set(staff()).expect(200)).body.data;
    expect(list).toMatchObject({ expressPct: 50, custom: false });
    expect(list.items.length).toBeGreaterThan(0);
    await ctx.api().put(`${V1}/laundry/prices`).set(mgr()).send({ expressPct: 25, items: [] }).expect(403);
    await ctx.api().put(`${V1}/laundry/prices`).set(admin()).send({ expressPct: 25, items: [{ name: 'Shirt', service: 'IRON', price: '15.00' }] }).expect(200);
    expect((await ctx.api().get(`${V1}/laundry/prices`).set(staff()).expect(200)).body.data).toMatchObject({ expressPct: 25, custom: true, items: [{ name: 'Shirt', service: 'IRON', price: '15.00' }] });
    expect((await create({ express: true }).expect(201)).body.data).toMatchObject({ subtotal: 120, expressCharge: 30, amount: 150 });
  });
});
