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
const staff = () => bearer(ctx.token.STAFF);
const checkIn = async (number: string, phone: string) =>
  (await ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId: await ctx.roomId(number), guestName: `Guest ${number}`, phone, nights: 2 }).expect(201)).body.data.stay;
const put = (id: string, body: unknown, as = mgr()) => ctx.api().put(`${V1}/stays/${id}/bill-tax`).set(as).send(body as object);
const bill = async (id: string) => (await ctx.api().get(`${V1}/stays/${id}/bill`).set(staff()).expect(200)).body.data;
const userId = async (role: string) => String(((await ctx.model('User').findOne({ role }).lean()) as any)._id);

describe('PUT /stays/:id/bill-tax', () => {
  it('saves, then overwrites; GET /stays/:id, in-house and rooms show it; each change is audited', async () => {
    const stay = await checkIn('101', '9877000001');
    expect((await ctx.api().get(`${V1}/stays/${stay.id}`).set(staff()).expect(200)).body.data.billTax).toBeNull();

    const first = (await put(stay.id, { rates: { stay: 5, food: 5, other: 18 } }).expect(200)).body.data;
    expect(first).toMatchObject({ stayId: stay.id, billTax: { stay: 5, food: 5, other: 18 }, updatedBy: await userId('MANAGER') });
    expect(new Date(first.updatedAt).getTime()).not.toBeNaN();

    const second = (await put(stay.id, { rates: { stay: 12.5, food: 0, other: 28 } }, admin()).expect(200)).body.data;
    expect(second).toMatchObject({ billTax: { stay: 12.5, food: 0, other: 28 }, updatedBy: await userId('ADMIN') });

    const one = (await ctx.api().get(`${V1}/stays/${stay.id}`).set(staff()).expect(200)).body.data;
    expect(one.billTax).toMatchObject({ stay: 12.5, food: 0, other: 28, updatedBy: await userId('ADMIN') });
    const inHouse = (await ctx.api().get(`${V1}/stays/in-house`).set(staff()).expect(200)).body.data.find((s: any) => s.id === stay.id);
    expect(inHouse.billTax).toMatchObject({ stay: 12.5, food: 0, other: 28 });
    const rooms = (await ctx.api().get(`${V1}/rooms`).set(mgr()).expect(200)).body.data;
    expect(JSON.stringify(rooms.find((r: any) => r.number === '101'))).toContain('"billTax":{"stay":12.5,"food":0,"other":28');

    const logs = (await ctx.model('AuditLog').find({ action: 'BILL_TAX_UPDATE', stayId: stay.id }).sort({ createdAt: 1 }).lean()) as any[];
    expect(logs.map((l) => l.details)).toEqual([
      { old: null, new: { stay: 5, food: 5, other: 18 } },
      { old: { stay: 5, food: 5, other: 18 }, new: { stay: 12.5, food: 0, other: 28 } },
    ]);
    expect(String(logs[1].userId)).toBe(await userId('ADMIN'));
  });

  it('bad rates are 400 and change nothing', async () => {
    const stay = await checkIn('102', '9877000002');
    const bad = [
      { rates: { stay: -1, food: 5, other: 18 } },
      { rates: { stay: 101, food: 5, other: 18 } },
      { rates: { stay: 'abc', food: 5, other: 18 } },
      { rates: { stay: '5', food: 5, other: 18 } },
      { rates: { stay: 5.125, food: 5, other: 18 } },
      { rates: { stay: 5, food: 5 } },
      { rates: { stay: 5, food: 5, other: 18, laundry: 18 } },
      { rates: { stay: 5, food: 5, other: null } },
      { rates: { stay: 5, food: 5, other: 18 }, extra: 1 },
      {},
    ];
    for (const body of bad) {
      const res = await put(stay.id, body);
      expect([res.status, res.body.code, JSON.stringify(body)]).toEqual([400, 'VALIDATION_ERROR', JSON.stringify(body)]);
      expect(typeof res.body.message).toBe('string');
    }
    await put(stay.id, { rates: { stay: 0, food: 100, other: 99.99 } }).expect(200);
    expect(await ctx.model('AuditLog').countDocuments({ action: 'BILL_TAX_UPDATE', stayId: stay.id })).toBe(1);
  });

  it('unknown stay is 404; a checked-out stay is 409 STAY_CLOSED', async () => {
    expect((await put('64b000000000000000000000', { rates: { stay: 5, food: 5, other: 18 } }).expect(404)).body.code).toBe('NOT_FOUND');
    await ctx.api().get(`${V1}/stays/64b000000000000000000000`).set(staff()).expect(404);

    const stay = await checkIn('103', '9877000003');
    await put(stay.id, { rates: { stay: 5, food: 5, other: 18 } }).expect(200);
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200);
    const res = await put(stay.id, { rates: { stay: 18, food: 5, other: 18 } }).expect(409);
    expect(res.body).toMatchObject({ code: 'STAY_CLOSED', message: expect.any(String) });
    expect(((await ctx.model('Stay').findById(stay.id).lean()) as any).billTax).toMatchObject({ stay: 5 });
  });
});

describe('The bill uses the fixed rates', () => {
  it('only the tax breakup changes: totals, balance, folio and day book stay the same; prints record the rates', async () => {
    const stay = await checkIn('104', '9877000004');
    const daybook = async () => (await ctx.api().get(`${V1}/daybook`).query({ date: ctx.today }).set(admin()).expect(200)).body.data;
    const folio = async () => JSON.stringify(await ctx.model('FolioLine').find({ stayId: stay.id }).sort({ _id: 1 }).lean());
    const before = { bill: await bill(stay.id), daybook: await daybook(), folio: await folio() };
    expect(before.bill.billTax).toBeNull();

    await put(stay.id, { rates: { stay: 18, food: 5, other: 18 } }).expect(200);
    const after = await bill(stay.id);
    const stayBefore = before.bill.sections.find((x: any) => x.key === 'STAY');
    const stayAfter = after.sections.find((x: any) => x.key === 'STAY');

    expect(after.billTax).toMatchObject({ stay: 18, food: 5, other: 18 });
    expect([after.total, after.paid, after.balance]).toEqual([before.bill.total, before.bill.paid, before.bill.balance]);
    expect(stayAfter.total).toBe(stayBefore.total);
    expect(stayAfter.gstRate).toBe(18);
    // The same total split again at 18%: taxable = total / 1.18, CGST = SGST.
    const total = Number(stayAfter.total);
    expect(Number(stayAfter.taxable)).toBeCloseTo(total / 1.18, 1);
    expect(stayAfter.cgst).toBe(stayAfter.sgst);
    expect((Number(stayAfter.taxable) + Number(stayAfter.cgst) + Number(stayAfter.sgst)).toFixed(2)).toBe(stayAfter.total);
    // Items add up to the new taxable value, at the fixed rate.
    expect(stayAfter.lines.reduce((t: number, l: any) => t + Number(l.amount), 0).toFixed(2)).toBe(stayAfter.taxable);
    expect(stayAfter.lines.every((l: any) => l.gstRate === 18)).toBe(true);

    expect(await folio()).toBe(before.folio);
    expect(await daybook()).toEqual(before.daybook);

    const print = (await ctx.api().post(`${V1}/stays/${stay.id}/bill-prints`).set(staff())
      .send({ type: 'GENERATED', which: 'combined', amounts: { stay: stayAfter.total }, actualAmounts: { stay: stayAfter.total } }).expect(201)).body.data;
    expect(print.billTax).toEqual({ stay: 18, food: 5, other: 18 });
    expect(print.serverAmounts.stay).toBe(stayBefore.total);
  });
});
