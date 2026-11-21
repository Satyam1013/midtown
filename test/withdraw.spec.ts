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
const post = (body: object) => ctx.api().post(`${V1}/entries`).set(mgr()).send({ time: '12:00', ...body });
const daybook = async (date = ctx.today) => (await ctx.api().get(`${V1}/daybook`).query({ date }).set(admin()).expect(200)).body.data;
const summary = async () => (await ctx.api().get(`${V1}/reports/summary`).set(admin()).expect(200)).body.data;

describe('Withdraw entries', () => {
  it('is always a debit: CREDIT is 400, zero is 400; BANK by default', async () => {
    expect((await post({ type: 'Withdraw', dc: 'CREDIT', mode: 'BANK', amount: '100.00' }).expect(400)).body.code).toBe('WITHDRAW_IS_DEBIT');
    expect((await post({ type: 'withdraw', amount: '0' }).expect(400)).body.code).toBe('AMOUNT_REQUIRED');
    const e = (await post({ type: 'withdraw', amount: '250.00', guestName: 'Owner' }).expect(201)).body.data;
    expect(e).toMatchObject({ type: 'Withdraw', dc: 'DEBIT', mode: 'BANK', source: 'WITHDRAW', amount: 250, roomId: null });
    // Ordinary entries still need mode and dc.
    expect((await post({ type: 'Other receipt', amount: '10.00', guestName: 'X' }).expect(400)).body.code).toBe('MODE_REQUIRED');
  });

  it('lowers the closing balance, shows as a debit in the register; not a sale or an expense', async () => {
    const book = await daybook();
    const sum = await summary();
    const e = (await post({ type: 'Withdraw', mode: 'CASH', dc: 'DEBIT', amount: '1000.00', guestName: 'Partner' }).expect(201)).body.data;
    const after = await daybook();
    expect(after.closingBalance).toBe(book.closingBalance - 1000);
    expect(after.debits).toBe(book.debits + 1000);
    expect(after.totalWithdraw).toBe(book.totalWithdraw + 1000);
    const line = (await ctx.api().get(`${V1}/daybook/register`).query({ date: ctx.today }).set(mgr()).expect(200)).body.data.find((l: any) => l.id === e.id);
    expect(line).toMatchObject({ type: 'Withdraw', dc: 'DEBIT', mode: 'CASH', source: 'WITHDRAW', amount: 1000 });
    const s = await summary();
    expect([s.totalSales, s.totalExpenses]).toEqual([sum.totalSales, sum.totalExpenses]);
    expect(Number(s.totalWithdraw)).toBe(Number(sum.totalWithdraw) + 1000);

    const rows = (await ctx.api().get(`${V1}/reports/entries`).query({ category: 'WITHDRAW' }).set(admin()).expect(200)).body;
    expect(rows.data.map((r: any) => r.id)).toContain(e.id);
    expect(rows.data.every((r: any) => r.category === 'WITHDRAW' && r.type === 'Withdraw')).toBe(true);
    const all = (await ctx.api().get(`${V1}/reports/entries`).set(admin()).expect(200)).body.data;
    expect(all.some((r: any) => r.id === e.id)).toBe(true);
    const expense = (await ctx.api().get(`${V1}/reports/entries`).query({ category: 'EXPENSE' }).set(admin()).expect(200)).body.data;
    expect(expense.some((r: any) => r.id === e.id)).toBe(false);
  });

  it('the duplicate rule applies; edits keep it a debit; every change is audited', async () => {
    const body = { type: 'Withdraw', amount: '300.00', guestName: 'Owner Two' };
    const e = (await post(body).expect(201)).body.data;
    expect((await post(body).expect(409)).body.code).toBe('DUPLICATE_ENTRY');
    expect((await ctx.api().patch(`${V1}/entries/${e.id}`).set(mgr()).send({ dc: 'CREDIT' }).expect(400)).body.code).toBe('WITHDRAW_IS_DEBIT');
    await ctx.api().patch(`${V1}/entries/${e.id}`).set(mgr()).send({ amount: '350.00', mode: 'UPI' }).expect(200);
    await ctx.api().delete(`${V1}/entries/${e.id}`).set(mgr()).expect(200);
    const actions = ((await ctx.model('AuditLog').find({ action: 'WITHDRAW', 'details.entryId': e.id }).lean()) as any[]).map((l) => l.details.action);
    expect(actions.sort()).toEqual(['CREATE', 'DELETE', 'UPDATE']);
  });

  it('a closed day can no longer be changed', async () => {
    const e = (await post({ type: 'Withdraw', amount: '50.00', guestName: 'Late' }).expect(201)).body.data;
    await ctx.api().post(`${V1}/business-day/close`).set(admin()).send({ businessDate: ctx.today, countedCash: '0', note: 'test', time: '23:00' }).expect(200);
    const last = (await ctx.api().get(`${V1}/business-day/current`).set(admin()).expect(200)).body.data.lastClosingBalance;
    await ctx.api().post(`${V1}/business-day/start`).set(admin()).send({ businessDate: day(1), openingBalance: String(last), time: '08:00' }).expect(200);
    expect((await ctx.api().patch(`${V1}/entries/${e.id}`).set(admin()).send({ amount: '60.00' }).expect(409)).body.code).toBe('DAY_CLOSED');
    expect((await ctx.api().delete(`${V1}/entries/${e.id}`).set(admin()).expect(409)).body.code).toBe('DAY_CLOSED');
    await ctx.api().patch(`${V1}/entries/${e.id}`).set(mgr()).send({ amount: '60.00' }).expect(403);
  });
});
