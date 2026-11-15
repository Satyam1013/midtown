import { bearer, bootApp, checkIn, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;

beforeAll(async () => {
  ctx = await bootApp();
});

afterAll(async () => {
  await ctx.app.close();
});

const staff = () => bearer(ctx.token.STAFF);
const mgr = () => bearer(ctx.token.MANAGER);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);
const daybook = async () => (await ctx.api().get(`${V1}/daybook`).query({ date: ctx.today }).set(staff())).body.data;
const register = async () => (await ctx.api().get(`${V1}/daybook/register`).query({ date: ctx.today }).set(staff())).body.data;
const report = async (key: string) => (await ctx.api().get(`${V1}/reports/${key}`).query({ date: ctx.today }).set(mgr()).expect(200)).body.data;
const setDay = (status: 'OPEN' | 'CLOSED') => ctx.model('DayBook').updateOne({ businessDate: ctx.today }, { $set: { status } });

describe('Room images', () => {
  it('upload, list in order, serve publicly, delete', async () => {
    const roomId = await ctx.roomId('101');
    const up = (name: string, buf = PNG) => ctx.api().post(`${V1}/rooms/${roomId}/images`).set(mgr()).attach('file', buf, name);
    await ctx.api().post(`${V1}/rooms/${roomId}/images`).set(staff()).attach('file', PNG, 'a.png').expect(403);
    expect((await up('fake.jpg', Buffer.from('definitely not an image at all')).expect(400)).body.code).toBe('UNSUPPORTED_FILE');
    const a = (await up('a.png').expect(201)).body.data;
    const b = (await up('b.png').expect(201)).body.data;
    expect(a).toMatchObject({ id: expect.any(String), url: expect.stringMatching(/^\/api\/v1\/files\/images\/[0-9a-f]{24}$/) });

    const one = (await ctx.api().get(`${V1}/rooms/${roomId}`).set(staff()).expect(200)).body.data;
    expect(one.images).toEqual([{ id: a.id, url: a.url }, { id: b.id, url: b.url }]);
    // KITCHEN can read rooms (a regression fixed here).
    const list = (await ctx.api().get(`${V1}/rooms`).set(bearer(ctx.token.KITCHEN)).expect(200)).body.data;
    expect(list.find((r: any) => r.number === '101').images).toHaveLength(2);

    const img = await ctx.api().get(a.url).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    await ctx.api().delete(`${V1}/rooms/${roomId}/images/${a.id}`).set(mgr()).expect(200);
    expect((await ctx.api().get(`${V1}/rooms/${roomId}`).set(staff())).body.data.images).toEqual([{ id: b.id, url: b.url }]);
    await ctx.api().get(a.url).expect(404);
    // Maintenance history stays manager-only.
    await ctx.api().get(`${V1}/rooms/maintenance-history`).set(staff()).expect(403);
  });
});

describe('Menu, stock and staff from the app', () => {
  it('menu items: unique per category ignoring case, price > 0, photo, management only', async () => {
    const item = { name: 'Paneer Tikka', description: 'Smoky', price: '240.00', category: 'Starters', isVeg: true, available: true };
    await ctx.api().post(`${V1}/menu`).set(staff()).send(item).expect(403);
    const created = (await ctx.api().post(`${V1}/menu`).set(mgr()).send(item).expect(201)).body.data;
    expect(created).toMatchObject({ id: expect.any(String), name: 'Paneer Tikka', price: 240, category: 'Starters', isVeg: true, photoUrl: null });
    expect((await ctx.api().post(`${V1}/menu`).set(mgr()).send({ ...item, name: 'paneer TIKKA' }).expect(409)).body.code).toBe('MENU_ITEM_EXISTS');
    await ctx.api().post(`${V1}/menu`).set(mgr()).send({ ...item, category: 'Mains' }).expect(201);
    await ctx.api().post(`${V1}/menu`).set(mgr()).send({ ...item, name: 'Free Thing', price: '0' }).expect(400);
    const photo = (await ctx.api().post(`${V1}/menu/${created.id}/photo`).set(mgr()).attach('file', PNG, 'p.png').expect(201)).body.data;
    expect(photo.photoUrl).toMatch(/^\/api\/v1\/files\/images\//);
    const menu = (await ctx.api().get(`${V1}/menu`).set(staff()).expect(200)).body.data;
    expect(menu.find((m: any) => m.id === created.id)).toEqual({
      id: created.id, name: 'Paneer Tikka', description: 'Smoky', price: 240, category: 'Starters', isVeg: true, photoUrl: photo.photoUrl, available: true,
    });
  });

  it('stock items: opening quantity is a movement; duplicate names rejected', async () => {
    const res = (await ctx.api().post(`${V1}/stock`).set(staff()).send({ item: 'Toor Dal', category: 'Kitchen', unit: 'kg', qty: '25', minQty: '5', rate: '90.00' }).expect(201)).body.data;
    expect(res).toMatchObject({ item: 'Toor Dal', qty: 25, minQty: 5, rate: 90 });
    expect(await ctx.model('StockMovement').find({ stockItemId: res.id }).lean()).toEqual([expect.objectContaining({ reason: 'Opening stock' })]);
    expect((await ctx.api().post(`${V1}/stock`).set(staff()).send({ item: 'toor DAL', category: 'Kitchen', unit: 'kg' }).expect(409)).body.code).toBe('STOCK_ITEM_EXISTS');
    const empty = (await ctx.api().post(`${V1}/stock`).set(staff()).send({ item: 'Saffron', category: 'Kitchen', unit: 'g' }).expect(201)).body.data;
    expect(await ctx.model('StockMovement').countDocuments({ stockItemId: empty.id })).toBe(0);
  });

  it('staff: managers add people; the list includes phone', async () => {
    const body = { name: 'Ramesh', role: 'Waiter', shift: 'Evening', phone: '+91 98765 43210', salary: '12000' };
    await ctx.api().post(`${V1}/staff`).set(staff()).send(body).expect(403);
    const res = (await ctx.api().post(`${V1}/staff`).set(mgr()).send(body).expect(201)).body.data;
    expect(res).toMatchObject({ id: expect.any(String), name: 'Ramesh', phone: '9876543210', salary: 12000 });
    expect((await ctx.api().get(`${V1}/staff`).set(mgr())).body.data.find((s: any) => s.id === res.id).phone).toBe('9876543210');
  });
});

describe('Customer credit (udhaar)', () => {
  let customerId: string;
  const post = (body: object) => ctx.api().post(`${V1}/customers/${customerId}/credit`).set(staff()).send({ time: '12:00', ...body });

  it('a charge moves no money and needs no open day; a payment is a receipt and needs one', async () => {
    const stay = await checkIn(ctx, '102', 'Credit Guest', '9811100001');
    customerId = stay.customerId;
    const book0 = await daybook();
    await setDay('CLOSED');
    const charge = (await post({ kind: 'CHARGE', amount: '500.00', narration: 'Mini bar', businessDate: ctx.today }).expect(201)).body.data;
    expect(charge).toMatchObject({ creditBalance: 500, entry: { kind: 'CHARGE', amount: 500, mode: null }, receipt: null });
    expect((await post({ kind: 'PAYMENT', amount: '100.00', mode: 'UPI' }).expect(409)).body.code).toBe('DAY_NOT_OPEN');
    await setDay('OPEN');
    expect(await daybook()).toMatchObject({ credits: book0.credits, debits: book0.debits });

    expect((await post({ kind: 'PAYMENT', amount: '200.00' }).expect(400)).body.code).toBe('MODE_REQUIRED');
    const paid = (await post({ kind: 'PAYMENT', amount: '200.00', mode: 'UPI', narration: 'Part' }).expect(201)).body.data;
    expect(paid).toMatchObject({ creditBalance: 300, receipt: { source: 'CUSTOMER_CREDIT', dc: 'CREDIT', mode: 'UPI', amount: 200 } });
    expect((await daybook()).credits - book0.credits).toBeCloseTo(200);
    expect((await register()).filter((l: any) => l.source === 'CUSTOMER_CREDIT')).toHaveLength(1);
    expect((await post({ kind: 'PAYMENT', amount: '300.01', mode: 'CASH' }).expect(409)).body.code).toBe('CREDIT_EXCEEDED');

    const detail = (await ctx.api().get(`${V1}/customers/${customerId}`).set(staff())).body.data;
    expect(detail.creditBalance).toBe(300);
    expect(detail.creditEntries.map((e: any) => [e.kind, e.amount, e.mode])).toEqual([['PAYMENT', 200, 'UPI'], ['CHARGE', 500, null]]);
    const owing = (await ctx.api().get(`${V1}/customers`).query({ hasCredit: 'true' }).set(staff()).expect(200)).body.data;
    expect(owing).toEqual([expect.objectContaining({ id: customerId, creditBalance: 300 })]);
    expect(await ctx.model('AuditLog').countDocuments({ action: 'CUSTOMER_CREDIT' })).toBe(2);
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200);
  });

  it('check-out can move the unpaid balance onto the customer\'s credit', async () => {
    const stay = await checkIn(ctx, '103', 'Credit Guest', '9811100001'); // same customer
    const owed = (await ctx.api().get(`${V1}/stays/${stay.id}/bill`).set(staff())).body.data.balance;
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff())
      .send({ payments: [{ mode: 'CASH', amount: '1000.00', time: '11:00' }], creditAmount: String(Number(owed)) }).expect(400);
    const out = (await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff())
      .send({ payments: [{ mode: 'CASH', amount: '1000.00', time: '11:00' }], creditAmount: (Number(owed) - 1000).toFixed(2) }).expect(200)).body.data;
    expect(out).toMatchObject({ shortfall: 0, folioBalance: '0.00' });
    expect(out.finalBill.payments).toEqual(expect.arrayContaining([{ mode: 'CREDIT', amount: (Number(owed) - 1000).toFixed(2) }]));
    const detail = (await ctx.api().get(`${V1}/customers/${customerId}`).set(staff())).body.data;
    expect(detail.creditBalance).toBeCloseTo(300 + Number(owed) - 1000);
    expect(detail.creditEntries[0]).toMatchObject({ kind: 'CHARGE', stayId: stay.id });
    const rows = (await report('receivables')).rows;
    expect(rows).toEqual([['Credit Guest', '9811100001', detail.creditBalance, detail.creditBalance, 0, 0, 0, ctx.today]]);
  });
});

describe('Expenses on credit (udhari)', () => {
  it('booked without moving money; paid in parts; listed as due until settled', async () => {
    const base = { head: 'Vegetables', amount: '1000.00', time: '09:00', onCredit: true, dueDate: '2020-01-01', narration: 'Weekly veg' };
    expect((await ctx.api().post(`${V1}/expenses`).set(staff()).send(base).expect(400)).body.code).toBe('VENDOR_REQUIRED');
    expect((await ctx.api().post(`${V1}/expenses`).set(staff()).send({ ...base, vendor: 'Mandi', mode: 'CASH' }).expect(400)).body.code).toBe('MODE_NOT_ALLOWED');
    await ctx.api().post(`${V1}/expenses`).set(staff()).send({ head: 'Fuel', amount: '50.00' }).expect(400); // cash needs a mode
    const book0 = await daybook();
    const exp = (await ctx.api().post(`${V1}/expenses`).set(staff()).send({ ...base, vendor: 'Mandi' }).expect(201)).body.data;
    expect(exp).toMatchObject({ onCredit: true, mode: null, amount: 1000, paidAmount: 0, dueAmount: 1000, vendor: 'Mandi', businessDate: ctx.today });
    expect(await ctx.model('CashTxn').countDocuments({ expenseId: exp.id })).toBe(0);
    expect(await daybook()).toMatchObject({ debits: book0.debits });
    expect((await register()).find((l: any) => l.id === exp.id)).toMatchObject({ kind: 'expense', informational: true, onCredit: true });
    expect((await report('payables')).rows).toEqual([['Mandi', 1, 1000, 1000, 0, 0, 0, 1000, '']]); // due date passed → overdue

    const pay = (body: object) => ctx.api().post(`${V1}/expenses/${exp.id}/payments`).set(staff()).send({ time: '15:00', ...body });
    const first = (await pay({ amount: '600.00', mode: 'UPI' }).expect(201)).body.data;
    expect(first.expense).toMatchObject({ paidAmount: 600, dueAmount: 400 });
    expect(first.entry).toMatchObject({ source: 'EXPENSE_PAYMENT', dc: 'DEBIT', mode: 'UPI', amount: 600 });
    expect((await daybook()).debits - book0.debits).toBeCloseTo(600);
    expect((await pay({ amount: '400.01', mode: 'CASH' }).expect(400)).body.code).toBe('PAYMENT_TOO_HIGH');
    const due = (await ctx.api().get(`${V1}/expenses`).query({ status: 'DUE' }).set(staff()).expect(200)).body.data;
    expect(due).toEqual([expect.objectContaining({ id: exp.id, dueAmount: 400 })]);
    await setDay('CLOSED');
    expect((await pay({ amount: '400.00', mode: 'CASH' }).expect(409)).body.code).toBe('DAY_NOT_OPEN');
    await setDay('OPEN');
    await pay({ amount: '400.00', mode: 'CASH' }).expect(201);
    expect((await ctx.api().get(`${V1}/expenses`).query({ status: 'DUE' }).set(staff())).body.data).toEqual([]);
    expect((await daybook()).debits - book0.debits).toBeCloseTo(1000);
    expect((await report('payables')).rows).toEqual([]);

    // Counted once, as an expense on the day it was booked.
    const summary = (await ctx.api().get(`${V1}/expenses/summary`).query({ date: ctx.today }).set(staff())).body.data;
    expect(summary.byHead.find((h: any) => h.head === 'Vegetables')).toMatchObject({ total: 1000, count: 1 });
    expect((await report('expenses')).rows.find((r: any[]) => r[0] === 'Vegetables')).toEqual(['Vegetables', 'Mandi', 'Credit', 'Weekly veg', 1000]);
    // Payments can't be edited through /entries.
    await ctx.api().patch(`${V1}/entries/${first.entry.id}`).set(staff()).send({ amount: '1.00' }).expect(400);
    expect(await ctx.model('AuditLog').countDocuments({ action: { $in: ['EXPENSE_CREDIT', 'EXPENSE_PAYMENT'] } })).toBe(3);
  });
});
