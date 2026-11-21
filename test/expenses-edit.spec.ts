import { bearer, bootApp, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;
let staffMember: any;

beforeAll(async () => {
  ctx = await bootApp();
  staffMember = (await ctx.api().get(`${V1}/staff`).set(bearer(ctx.token.STAFF)).expect(200)).body.data[0];
});

afterAll(async () => {
  await ctx.app.close();
});

const admin = () => bearer(ctx.token.ADMIN);
const mgr = () => bearer(ctx.token.MANAGER);
const staff = () => bearer(ctx.token.STAFF);
const day = (n: number) => {
  const d = new Date(`${ctx.today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const create = async (body: object) => (await ctx.api().post(`${V1}/expenses`).set(staff()).send(body).expect(201)).body.data;
const patch = (id: string, body: object, as = admin()) => ctx.api().patch(`${V1}/expenses/${id}`).set(as).send(body);
const remove = (id: string, as = admin()) => ctx.api().delete(`${V1}/expenses/${id}`).set(as);
const daybook = async (date = ctx.today) => (await ctx.api().get(`${V1}/daybook`).query({ date }).set(admin()).expect(200)).body.data;
const register = async (date = ctx.today) => (await ctx.api().get(`${V1}/daybook/register`).query({ date }).set(admin()).expect(200)).body.data;
const totalExpenses = async () => Number((await ctx.api().get(`${V1}/reports/summary`).query({ from: ctx.today, to: ctx.today }).set(admin()).expect(200)).body.data.totalExpenses);

describe('Salary advance', () => {
  it('needs an existing staff member and is paid now', async () => {
    const base = { head: 'Salary advance', vendor: staffMember.name, mode: 'CASH', amount: '2000.00' };
    const bad = async (body: object) => (await ctx.api().post(`${V1}/expenses`).set(staff()).send(body).expect(400)).body.code;
    expect(await bad(base)).toBe('STAFF_REQUIRED');
    expect(await bad({ ...base, staffId: '64b7f0000000000000000000' })).toBe('STAFF_NOT_FOUND');
    expect(await bad({ ...base, staffId: staffMember.id, mode: undefined, onCredit: true })).toBe('ADVANCE_ON_CREDIT');

    const saved = await create({ ...base, staffId: staffMember.id });
    expect(saved).toMatchObject({ head: 'Salary advance', vendor: staffMember.name, staffId: staffMember.id, amount: 2000 });
    const listed = (await ctx.api().get(`${V1}/expenses`).set(staff()).expect(200)).body.data.find((x: any) => x.id === saved.id);
    expect(listed.staffId).toBe(staffMember.id);

    const advances = (await ctx.api().get(`${V1}/staff/${staffMember.id}/advances`).set(mgr()).expect(200)).body.data;
    expect(advances).toMatchObject({ staffId: staffMember.id, total: 2000, advances: [expect.objectContaining({ id: saved.id, amount: 2000 })] });
    await ctx.api().get(`${V1}/staff/${staffMember.id}/advances`).set(staff()).expect(403);
    expect(typeof staffMember.salary).toBe('number');
  });
});

describe('PATCH /expenses/:id', () => {
  it('ADMIN only; the day book moves by exactly the difference', async () => {
    const e = await create({ head: 'Fuel', vendor: 'Pump', mode: 'CASH', amount: '400.00' });
    const before = await daybook();
    expect((await patch(e.id, { amount: '1.00' }, mgr()).expect(403)).body).toMatchObject({ code: 'FORBIDDEN', message: 'Admin access required' });

    const res = (await patch(e.id, { amount: '650.00', mode: 'UPI', head: 'Diesel', narration: 'Generator' }).expect(200)).body.data;
    expect(res).toMatchObject({ id: e.id, amount: 650, mode: 'UPI', head: 'Diesel', narration: 'Generator', paidAmount: 650 });
    expect((await daybook()).debits).toBe(before.debits + 250);
    const txn = (await ctx.model('CashTxn').findOne({ expenseId: e.id }).lean()) as any;
    expect([txn.mode, String(txn.amount), txn.head]).toEqual(['UPI', '650.00', 'Diesel']);
    const listed = (await ctx.api().get(`${V1}/expenses`).set(staff()).expect(200)).body.data.find((x: any) => x.id === e.id);
    expect(Object.keys(res).sort()).toEqual(Object.keys(listed).sort());
    expect(await ctx.model('AuditLog').countDocuments({ action: 'EXPENSE_UPDATE', 'details.expenseId': e.id })).toBe(1);
  });

  it('credit expenses: amount never below what is paid; onCredit and mode are fixed', async () => {
    const e = await create({ head: 'Groceries', vendor: 'Mandi', onCredit: true, amount: '1000.00', dueDate: day(10) });
    await ctx.api().post(`${V1}/expenses/${e.id}/payments`).set(staff()).send({ amount: '600.00', mode: 'CASH' }).expect(201);
    expect((await patch(e.id, { amount: '500.00' }).expect(409)).body.code).toBe('EXPENSE_PAYMENTS_EXIST');
    const res = (await patch(e.id, { amount: '800.00', dueDate: day(12) }).expect(200)).body.data;
    expect(res).toMatchObject({ amount: 800, paidAmount: 600, dueAmount: 200, dueDate: day(12), onCredit: true });
    expect((await patch(e.id, { onCredit: false }).expect(400)).body.code).toBe('ON_CREDIT_LOCKED');
    await patch(e.id, { onCredit: true, note: undefined }).expect(200);
    expect((await patch(e.id, { mode: 'CASH' }).expect(400)).body.code).toBe('MODE_NOT_ALLOWED');
    expect((await patch(e.id, { head: 'Salary advance', staffId: staffMember.id }).expect(400)).body.code).toBe('ADVANCE_ON_CREDIT');
  });
});

describe('DELETE /expenses/:id', () => {
  it('ADMIN only: 204, gone from the day book, register and reports; audited; then 404', async () => {
    const dayBefore = await daybook();
    const reportBefore = await totalExpenses();
    const e = await create({ head: 'Repairs', vendor: 'Plumber', mode: 'CASH', amount: '350.00' });
    expect((await daybook()).debits).toBe(dayBefore.debits + 350);
    expect(await totalExpenses()).toBe(reportBefore + 350);

    await remove(e.id, mgr()).expect(403);
    await remove(e.id).expect(204);
    expect((await daybook()).debits).toBe(dayBefore.debits);
    expect(await totalExpenses()).toBe(reportBefore);
    expect((await register()).some((l: any) => l.id === e.id)).toBe(false);
    expect((await ctx.api().get(`${V1}/expenses`).set(staff()).expect(200)).body.data.some((x: any) => x.id === e.id)).toBe(false);
    expect(await ctx.model('CashTxn').countDocuments({ expenseId: e.id })).toBe(0);
    const saved = (await ctx.model('Expense').findById(e.id).setOptions({ withDeleted: true }).lean()) as any;
    expect(saved.deletedAt).toBeInstanceOf(Date);
    expect(saved.deletedByUserId).toBeTruthy();
    const log = (await ctx.model('AuditLog').findOne({ action: 'EXPENSE_DELETE', 'details.expenseId': e.id }).lean()) as any;
    expect(log.details.before).toMatchObject({ head: 'Repairs', vendor: 'Plumber', mode: 'CASH' });
    await remove(e.id).expect(404);
  });

  it('a credit expense with payments is 409 EXPENSE_PAYMENTS_EXIST; an unpaid one goes', async () => {
    const paid = await create({ head: 'Linen', vendor: 'Dhobi', onCredit: true, amount: '900.00' });
    await ctx.api().post(`${V1}/expenses/${paid.id}/payments`).set(staff()).send({ amount: '100.00', mode: 'UPI' }).expect(201);
    expect((await remove(paid.id).expect(409)).body.code).toBe('EXPENSE_PAYMENTS_EXIST');
    const unpaid = await create({ head: 'Linen', vendor: 'Dhobi', onCredit: true, amount: '300.00' });
    await remove(unpaid.id).expect(204);
    const due = (await ctx.api().get(`${V1}/expenses`).query({ status: 'DUE' }).set(admin()).expect(200)).body.data;
    expect(due.some((x: any) => x.id === unpaid.id)).toBe(false);
  });

  it('a closed day can be neither edited nor deleted: 409 DAY_CLOSED', async () => {
    const e = await create({ head: 'Fuel', vendor: 'Pump', mode: 'CASH', amount: '120.00' });
    await ctx.api().post(`${V1}/business-day/close`).set(admin()).send({ businessDate: ctx.today, countedCash: '0', note: 'test', time: '23:00' }).expect(200);
    const last = (await ctx.api().get(`${V1}/business-day/current`).set(admin()).expect(200)).body.data.lastClosingBalance;
    await ctx.api().post(`${V1}/business-day/start`).set(admin()).send({ businessDate: day(1), openingBalance: String(last), time: '08:00' }).expect(200);
    expect((await patch(e.id, { amount: '130.00' }).expect(409)).body.code).toBe('DAY_CLOSED');
    expect((await remove(e.id).expect(409)).body.code).toBe('DAY_CLOSED');
  });
});
