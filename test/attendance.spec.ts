import { bearer, bootApp, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;
let staffIds: string[];

beforeAll(async () => {
  ctx = await bootApp();
  staffIds = (await ctx.api().get(`${V1}/staff`).set(bearer(ctx.token.STAFF)).expect(200)).body.data.map((s: any) => s.id);
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
const put = (body: object, as = mgr()) => ctx.api().put(`${V1}/attendance`).set(as).send(body);
const read = (q: object, as = mgr()) => ctx.api().get(`${V1}/attendance`).query(q).set(as);

describe('Attendance', () => {
  it('a manager marks only the open day; an admin any past day; nobody a future one', async () => {
    await put({ staffId: staffIds[0], businessDate: ctx.today, mark: 'P' }).expect(200);
    expect((await put({ staffId: staffIds[0], businessDate: day(-3), mark: 'A' }).expect(403)).body.code).toBe('PAST_DATE_RESTRICTED');
    await put({ staffId: staffIds[0], businessDate: day(-3), mark: 'A' }, admin()).expect(200);
    await put({ staffId: staffIds[0], businessDate: day(-40), mark: 'L' }, admin()).expect(200);
    expect((await put({ staffId: staffIds[0], businessDate: day(1), mark: 'P' }, admin()).expect(400)).body.code).toBe('FUTURE_DATE');
    expect((await put({ staffId: '64b7f0000000000000000000', businessDate: ctx.today, mark: 'P' }).expect(404)).body.code).toBe('NOT_FOUND');
  });

  it('marking twice keeps one row; PRESENT / ABSENT / LEAVE are accepted as P / A / L; changes are audited', async () => {
    await put({ staffId: staffIds[1], businessDate: ctx.today, mark: 'PRESENT' }).expect(200);
    const res = (await put({ staffId: staffIds[1], businessDate: ctx.today, mark: 'leave' }).expect(200)).body.data;
    expect(res.mark).toBe('L');
    expect(await ctx.model('Attendance').countDocuments({ staffId: staffIds[1], businessDate: ctx.today })).toBe(1);
    const logs = (await ctx.model('AuditLog').find({ action: 'ATTENDANCE_MARK', 'details.staffId': staffIds[1] }).sort({ createdAt: 1 }).lean()) as any[];
    expect(logs.map((l) => [l.details.from, l.details.to])).toEqual([[null, 'P'], ['P', 'L']]);
    await put({ staffId: staffIds[1], businessDate: ctx.today, mark: 'X' }).expect(400);
  });

  it('a manager reads any past month, by day or range, for everyone or one person', async () => {
    const month = (await read({ from: day(-45), to: ctx.today, staffId: staffIds[0] }).expect(200)).body.data;
    expect(month.map((r: any) => [r.businessDate, r.mark])).toEqual([[day(-40), 'L'], [day(-3), 'A'], [ctx.today, 'P']]);
    expect((await read({ date: ctx.today }).expect(200)).body.data.length).toBeGreaterThanOrEqual(2);
    expect((await read({}).expect(400)).body.code).toBe('DATE_REQUIRED');
    expect((await read({ from: ctx.today, to: day(-1) }).expect(400)).body.code).toBe('INVALID_RANGE');
    expect((await read({ from: day(-400), to: ctx.today }).expect(400)).body.code).toBe('RANGE_TOO_LONG');
    expect((await read({ date: '2026-02-30' }).expect(400)).body.code).toBe('INVALID_DATE');
  });

  it('bulk marks a date in one go', async () => {
    const res = (await ctx.api().post(`${V1}/attendance/bulk`).set(mgr()).send({ businessDate: ctx.today, marks: staffIds.map((staffId) => ({ staffId, mark: 'P' })) }).expect(200)).body.data;
    expect(res).toHaveLength(staffIds.length);
    expect(await ctx.model('Attendance').countDocuments({ businessDate: ctx.today })).toBe(staffIds.length);
    await ctx.api().post(`${V1}/attendance/bulk`).set(mgr()).send({ businessDate: day(-1), marks: [{ staffId: staffIds[0], mark: 'P' }] }).expect(403);
  });
});

describe('Staff edit and delete', () => {
  it('PATCH validates and returns the GET /staff shape', async () => {
    const res = (await ctx.api().patch(`${V1}/staff/${staffIds[2]}`).set(mgr()).send({ name: 'Ravi K', salary: '15000', phone: '98765 43210', shift: 'Night' }).expect(200)).body.data;
    expect(res).toMatchObject({ id: staffIds[2], name: 'Ravi K', salary: 15000, phone: '9876543210', shift: 'Night' });
    const row = (await ctx.api().get(`${V1}/staff`).set(mgr()).expect(200)).body.data.find((s: any) => s.id === staffIds[2]);
    expect(Object.keys(res).sort()).toEqual(Object.keys(row).sort());
    await ctx.api().patch(`${V1}/staff/${staffIds[2]}`).set(mgr()).send({ name: '' }).expect(400);
    await ctx.api().patch(`${V1}/staff/${staffIds[2]}`).set(mgr()).send({ salary: '-1' }).expect(400);
    await ctx.api().patch(`${V1}/staff/${staffIds[2]}`).set(bearer(ctx.token.STAFF)).send({ name: 'x' }).expect(403);
  });

  it('DELETE: ADMIN only; gone from GET /staff and salary advances; attendance and advances kept', async () => {
    const id = staffIds[0];
    const advance = (await ctx.api().post(`${V1}/expenses`).set(mgr()).send({ head: 'Salary advance', vendor: 'X', staffId: id, mode: 'CASH', amount: '500.00' }).expect(201)).body.data;
    await ctx.api().delete(`${V1}/staff/${id}`).set(mgr()).expect(403);
    await ctx.api().delete(`${V1}/staff/${id}`).set(admin()).expect(204);
    await ctx.api().delete(`${V1}/staff/${id}`).set(admin()).expect(404);
    expect((await ctx.api().get(`${V1}/staff`).set(mgr()).expect(200)).body.data.some((s: any) => s.id === id)).toBe(false);
    expect((await read({ from: day(-45), to: ctx.today, staffId: id }).expect(200)).body.data.length).toBe(3);
    expect((await ctx.api().get(`${V1}/staff/${id}/advances`).set(mgr()).expect(200)).body.data.advances.map((a: any) => a.id)).toEqual([advance.id]);
    expect((await ctx.api().post(`${V1}/expenses`).set(mgr()).send({ head: 'Salary advance', vendor: 'X', staffId: id, mode: 'CASH', amount: '1.00' }).expect(400)).body.code).toBe('STAFF_NOT_FOUND');
    expect((await put({ staffId: id, businessDate: ctx.today, mark: 'P' }).expect(404)).body.code).toBe('NOT_FOUND');
    expect(await ctx.model('AuditLog').countDocuments({ action: 'STAFF_DELETE', 'details.staffId': id })).toBe(1);
  });
});
