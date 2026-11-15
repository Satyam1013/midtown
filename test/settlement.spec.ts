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
const register = async () => (await ctx.api().get(`${V1}/daybook/register`).query({ date: ctx.today }).set(staff()).expect(200)).body.data;
const daybook = async () => (await ctx.api().get(`${V1}/daybook`).query({ date: ctx.today }).set(staff()).expect(200)).body.data;
const cashTotals = async () => {
  const rows = await ctx.model('CashTxn').find({ businessDate: ctx.today }).lean();
  const by: Record<string, number> = {};
  for (const r of rows as any[]) by[`${r.dc}:${r.mode}`] = (by[`${r.dc}:${r.mode}`] ?? 0) + Number(r.amount.toString());
  return by;
};
const owedOn = async (stayId: string) => Number((await ctx.api().get(`${V1}/stays/${stayId}/bill`).set(staff())).body.data.balance);

describe('One register row per check-out', () => {
  it('the app\'s old flow (PATCH payment, then check-out) gives one row with the typed narration and the shortfall', async () => {
    const stay = await checkIn(ctx, '106', 'Room 106 Guest', '9822200106');
    const owed = await owedOn(stay.id);
    await ctx.api().patch(`${V1}/stays/${stay.id}`).set(staff())
      .send({ payment: { kind: 'PART_PAYMENT', amount: '3000.00', mode: 'CASH', time: '11:00', narration: 'Final settlement' } }).expect(200);
    const before = await cashTotals();
    const out = (await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({ time: '11:01' }).expect(200)).body.data;
    expect(await cashTotals()).toEqual(before); // check-out itself moved no money

    const rows = (await register()).filter((l: any) => l.stayId === stay.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'entry', source: 'CHECKOUT', type: 'Check-out', roomNumber: '106', guestName: 'Room 106 Guest', dc: 'CREDIT',
      mode: 'CASH', amount: 3000, billTotal: owed, shortfall: owed - 3000, narration: 'Final settlement',
      payments: [{ mode: 'CASH', amount: 3000 }], customerId: stay.customerId, time: '11:01',
    });
    expect(rows[0].narration).not.toMatch(/unpaid/);
    expect(out.settlement.id).toBe(rows[0].id);
    // Zero-amount rows are gone; GET /daybook keeps the short-by highlight.
    expect((await register()).filter((l: any) => l.amount === 0 && l.source === 'CHECKOUT')).toEqual([]);
    expect((await daybook()).checkoutShortfall).toBeCloseTo(owed - 3000);
  });

  it('split payment and adjustments in one call: totals per mode exact, one row', async () => {
    const stay = await checkIn(ctx, '104', 'Split Guest', '9822200107');
    const before = await cashTotals();
    const book0 = await daybook();
    const owedBefore = await owedOn(stay.id);
    const out = (await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({
      time: '12:00',
      narration: 'Paid half cash, half UPI',
      adjustments: [{ kind: 'DISCOUNT', value: '10%', section: 'STAY', amount: '200.00', reason: 'Regular guest' }],
      payments: [{ mode: 'CASH', amount: '2000.00' }, { mode: 'UPI', amount: String(owedBefore - 200 - 2000) }],
    }).expect(200)).body.data;
    const after = await cashTotals();
    expect((after['CREDIT:CASH'] ?? 0) - (before['CREDIT:CASH'] ?? 0)).toBeCloseTo(2000);
    expect((after['CREDIT:UPI'] ?? 0) - (before['CREDIT:UPI'] ?? 0)).toBeCloseTo(owedBefore - 2200);
    expect((await daybook()).credits - book0.credits).toBeCloseTo(owedBefore - 200);

    const row = (await register()).find((l: any) => l.stayId === stay.id);
    expect(row).toMatchObject({ mode: 'MIXED', amount: owedBefore - 200, billTotal: owedBefore - 200, shortfall: null, narration: 'Paid half cash, half UPI' });
    expect(row.payments).toEqual([{ mode: 'CASH', amount: 2000 }, { mode: 'UPI', amount: owedBefore - 2200 }]);
    const stayBill = out.finalBill.sections.find((s: any) => s.key === 'STAY');
    expect(stayBill.lines.at(-1)).toMatchObject({ description: 'Discount: Regular guest' });
    expect(Number(stayBill.cgst)).toBe(Number(stayBill.sgst));
    expect(out.finalBill.balance).toBe('0.00');
    expect(await ctx.model('AuditLog').countDocuments({ action: 'STAY_ADJUSTMENT', stayId: stay.id })).toBe(1);

    // The register still adds up to the day book.
    const lines = (await register()).filter((l: any) => !l.informational);
    const credits = lines.filter((l: any) => l.dc === 'CREDIT').reduce((t: number, l: any) => t + l.amount, 0);
    expect(credits).toBeCloseTo((await daybook()).credits);
  });

  it('a discount larger than the section is refused and nothing is saved', async () => {
    const stay = await checkIn(ctx, '105', 'Too Much Off', '9822200108');
    const res = await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff())
      .send({ adjustments: [{ kind: 'COMPLIMENTARY', section: 'FOOD', amount: '50.00', reason: 'nothing ordered' }] }).expect(400);
    expect(res.body.code).toBe('ADJUSTMENT_TOO_HIGH');
    expect(((await ctx.model('Stay').findById(stay.id).lean()) as any).status).toBe('IN_HOUSE');
    expect(await ctx.model('FolioLine').countDocuments({ stayId: stay.id, source: 'ADJUSTMENT' })).toBe(0);
  });

  it('a retried check-out with the same Idempotency-Key posts nothing twice', async () => {
    const stay = await checkIn(ctx, '205', 'Double Tap', '9822200109').catch(async () => {
      await ctx.model('Room').updateOne({ number: '205' }, { $set: { status: 'VACANT' } });
      return checkIn(ctx, '205', 'Double Tap', '9822200109');
    });
    const body = { payments: [{ mode: 'CARD', amount: '500.00', time: '13:00' }] };
    const call = () => ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).set('Idempotency-Key', 'tap-108').send(body);
    const [a, b] = await Promise.all([call(), call()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.settlement.id).toBe(b.body.data.settlement.id);
    const again = await call().expect(200);
    expect(again.body.data.settlement.id).toBe(a.body.data.settlement.id);
    expect(await ctx.model('DayRegisterEntry').countDocuments({ stayId: stay.id, mode: 'CARD' })).toBe(1);
    // Without the key a second check-out is still refused.
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send(body).expect(409);
    // The key can't be reused for another stay.
    const other = await checkIn(ctx, '201', 'Other', '9822200110');
    expect((await ctx.api().post(`${V1}/stays/${other.id}/checkout`).set(staff()).set('Idempotency-Key', 'tap-108').send(body).expect(409)).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('entries list, customer history and the day-book export show one line per check-out', async () => {
    const stay = (await ctx.model('Stay').findOne({ guestName: 'Room 106 Guest' }).lean()) as any;
    const entries = (await ctx.api().get(`${V1}/entries`).query({ date: ctx.today }).set(staff()).expect(200)).body.data;
    expect(entries.filter((e: any) => String(e.stayId) === String(stay._id))).toEqual([expect.objectContaining({ type: 'Check-out', amount: 3000 })]);
    const customer = (await ctx.api().get(`${V1}/customers/${stay.customerId}`).set(staff())).body.data;
    expect(customer.payments).toEqual([expect.objectContaining({ type: 'Check-out', amount: 3000, narration: 'Final settlement', payments: [{ mode: 'CASH', amount: 3000 }] })]);
    const daily = (await ctx.api().get(`${V1}/reports/daily`).query({ date: ctx.today }).set(bearer(ctx.token.MANAGER))).body.data.rows;
    expect(daily.filter((r: any[]) => r[2] === 'Room 106 Guest')).toHaveLength(1);
    const cash = (await ctx.api().get(`${V1}/reports/cash`).query({ date: ctx.today }).set(bearer(ctx.token.MANAGER))).body.data.rows;
    const split = cash.filter((r: any[]) => r[0] === 'Check-out' && r[2] === 'Paid half cash, half UPI');
    expect(split).toHaveLength(1);
    expect(split[0][1]).toBe('MIXED');
  });

  it('each room of a multi-room booking gets its own row', async () => {
    const types = (await ctx.api().get(`${V1}/guest/room-types`).set(staff())).body.data;
    const booking = (await ctx.api().post(`${V1}/bookings`).set(staff())
      .send({ source: 'Walk-in', guestName: 'Group', phone: '9822200200', roomTypeId: types[0].id, rooms: 2, pax: 2, arrivalDate: ctx.today, departureDate: '2027-12-31', amount: '100' }).expect(201)).body.data;
    const ids: string[] = [];
    for (const n of ['202', '203']) {
      ids.push((await ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId: await ctx.roomId(n), guestName: `Group ${n}`, phone: '9822200200', nights: 1, bookingId: booking.id }).expect(201)).body.data.stay.id);
    }
    for (const id of ids) await ctx.api().post(`${V1}/stays/${id}/checkout`).set(staff()).send({ payments: [{ mode: 'UPI', amount: '100.00', time: '14:00' }] }).expect(200);
    expect((await register()).filter((l: any) => ids.includes(l.stayId)).map((l: any) => l.roomNumber).sort()).toEqual(['202', '203']);
  });
});
