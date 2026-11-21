import mongoose from 'mongoose';
import { bearer, bootApp, Ctx } from './helpers';

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
let n = 0;
const customer = async (name: string, lastVisitAt = new Date(Date.now() - ++n * 60_000)) =>
  String(((await ctx.model('Customer').create({ name, phone: `97770${String(++n).padStart(5, '0')}`, visits: 1, lastVisitAt })) as any)._id);
const credit = (id: string, body: object) => ctx.api().post(`${V1}/customers/${id}/credit`).set(staff()).send(body).expect(201);
const list = async (q: object = {}) => (await ctx.api().get(`${V1}/customers`).query({ limit: 200, ...q }).set(staff()).expect(200)).body;
const detail = async (id: string) => (await ctx.api().get(`${V1}/customers/${id}`).set(staff()).expect(200)).body.data;

describe('GET /customers: dueAmount', () => {
  let owes: string;
  let paidUp: string;
  let none: string;

  beforeAll(async () => {
    owes = await customer('Nikhil Sharma');
    paidUp = await customer('Paid Up');
    none = await customer('No Credit');
    await credit(owes, { kind: 'CHARGE', amount: '3000.00', narration: 'Room on credit' });
    await credit(owes, { kind: 'PAYMENT', amount: '1000.00', mode: 'CASH' });
    await credit(paidUp, { kind: 'CHARGE', amount: '500.00' });
    await credit(paidUp, { kind: 'PAYMENT', amount: '500.00', mode: 'UPI' });
  });

  it('3000 charged and 1000 paid is 2000.00 in the list and the detail', async () => {
    const row = (await list()).data.find((c: any) => c.id === owes);
    expect(row).toMatchObject({ name: 'Nikhil Sharma', dueAmount: '2000.00', visits: 1, hasDocument: false });
    expect(row).toHaveProperty('totalSpent');
    expect(row).toHaveProperty('lastVisitAt');
    expect((await detail(owes)).dueAmount).toBe('2000.00');
  });

  it('a paid-up customer and one with no credit are 0.00', async () => {
    const rows = (await list()).data;
    for (const id of [paidUp, none]) {
      expect(rows.find((c: any) => c.id === id).dueAmount).toBe('0.00');
      expect((await detail(id)).dueAmount).toBe('0.00');
    }
  });

  it('hasDue=true lists only customers who owe; sort=due_desc puts the most owed first', async () => {
    const small = await customer('Small Due');
    await credit(small, { kind: 'CHARGE', amount: '150.00' });
    expect((await list({ hasDue: 'true' })).data.map((c: any) => [c.id, c.dueAmount])).toEqual(
      expect.arrayContaining([[owes, '2000.00'], [small, '150.00']]),
    );
    expect((await list({ hasDue: 'true' })).data.every((c: any) => Number(c.dueAmount) > 0)).toBe(true);

    const sorted = (await list({ sort: 'due_desc' })).data.map((c: any) => Number(c.dueAmount));
    expect(sorted).toEqual([...sorted].sort((a, b) => b - a));
    // The cursor follows the due order.
    const first = await list({ sort: 'due_desc', hasDue: 'true', limit: 1 });
    expect(first.data[0].id).toBe(owes);
    const second = await list({ sort: 'due_desc', hasDue: 'true', limit: 1, cursor: first.meta.nextCursor });
    expect(second.data[0].id).toBe(small);
    await ctx.api().get(`${V1}/customers`).query({ sort: 'cheapest' }).set(staff()).expect(400);
  });

  it('merging customers carries the credit and its ledger over', async () => {
    const into = await customer('Merged Into');
    await ctx.api().post(`${V1}/customers/${owes}/merge`).set(mgr()).send({ intoCustomerId: into }).expect(200);
    const merged = await detail(into);
    expect(merged.dueAmount).toBe('2000.00');
    expect(merged.creditEntries).toHaveLength(2);
    await credit(into, { kind: 'PAYMENT', amount: '2000.00', mode: 'CASH' });
    expect((await detail(into)).dueAmount).toBe('0.00');
  });

  it('200 customers: one query for the list, however many customers (no N+1)', async () => {
    const base = Date.now();
    await ctx.model('Customer').insertMany(
      Array.from({ length: 200 }, (_, i) => ({ name: `Bulk ${i}`, phone: `96660${String(i).padStart(5, '0')}`, visits: 1, lastVisitAt: new Date(base - i * 1000), creditBalance: String(i) })),
    );
    const seen: string[] = [];
    mongoose.set('debug', (collection: string) => seen.push(collection));
    try {
      const res = await list();
      expect(res.data).toHaveLength(200);
    } finally {
      mongoose.set('debug', false);
    }
    // Auth reads the user once; the list itself is one query on customers.
    expect(seen.filter((c) => c === 'customers')).toHaveLength(1);
    expect(seen.filter((c) => c === 'customer_credit_entries')).toHaveLength(0);
  });
});
