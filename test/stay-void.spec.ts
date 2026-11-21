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
const day = (n: number) => {
  const d = new Date(`${ctx.today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const checkIn = async (number: string, phone: string, extra: object = {}) =>
  (await ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId: await ctx.roomId(number), guestName: `Guest ${number}`, phone, nights: 2, ...extra }).expect(201)).body.data.stay;
const remove = (id: string, as = admin(), body: object = {}) => ctx.api().delete(`${V1}/stays/${id}`).set(as).send(body);
const daybook = async (date: string) => (await ctx.api().get(`${V1}/daybook`).query({ date }).set(admin()).expect(200)).body.data;

describe('DELETE /stays/:id', () => {
  it('ADMIN only; voids the stay and its same-day advance; room back to VACANT; 204 then 404', async () => {
    const before = await daybook(ctx.today);
    const stay = await checkIn('101', '9855000001', { advance: { amount: '500.00', mode: 'CASH', time: '10:00' } });
    expect((await daybook(ctx.today)).credits).toBe(before.credits + 500);

    expect((await remove(stay.id, mgr()).expect(403)).body).toMatchObject({ code: 'FORBIDDEN', message: 'Admin access required' });
    await remove(stay.id, admin(), { reason: 'Wrong room picked' }).expect(204);
    await remove(stay.id).expect(404);

    // Day book and cash are back where they were; the advance is gone from the register.
    expect((await daybook(ctx.today)).credits).toBe(before.credits);
    const register = (await ctx.api().get(`${V1}/daybook/register`).query({ date: ctx.today }).set(admin()).expect(200)).body.data;
    expect(register.some((l: any) => l.guestName === 'Guest 101')).toBe(false);

    const rooms = (await ctx.api().get(`${V1}/rooms`).set(mgr()).expect(200)).body.data;
    expect(rooms.find((r: any) => r.number === '101')).toMatchObject({ status: 'VACANT', currentStay: null });
    const inHouse = (await ctx.api().get(`${V1}/stays/in-house`).set(mgr()).expect(200)).body.data;
    expect(JSON.stringify(inHouse)).not.toContain(stay.id);

    const saved = (await ctx.model('Stay').findById(stay.id).setOptions({ withDeleted: true }).lean()) as any;
    expect(saved).toMatchObject({ status: 'CANCELLED', voidReason: 'Wrong room picked' });
    expect(saved.deletedAt).toBeInstanceOf(Date);
    expect(String(saved.deletedByUserId)).toBe(String(((await ctx.model('User').findOne({ role: 'ADMIN' }).lean()) as any)._id));
    expect(await ctx.model('FolioLine').countDocuments({ stayId: stay.id })).toBe(0);
    const log = (await ctx.model('AuditLog').findOne({ action: 'STAY_VOID', stayId: stay.id }).lean()) as any;
    expect(log.details).toMatchObject({ roomNumber: '101', guestName: 'Guest 101', reason: 'Wrong room picked' });
    expect(log.details.voidedEntries).toHaveLength(1);

    // The room can be checked into again.
    await checkIn('101', '9855000009');
  });

  it('voids open service requests and unpaid KOTs; frees the booking line; drops a walk-in booking', async () => {
    const types = (await ctx.api().get(`${V1}/room-types`).set(staff()).expect(200)).body.data;
    const booking = (await ctx.api().post(`${V1}/bookings`).set(staff())
      .send({ source: 'Phone', guestName: 'Booked', phone: '9855000002', roomId: await ctx.roomId('102'), pax: 1, arrivalDate: ctx.today, departureDate: day(2) })
      .expect(201)).body.data;
    const stay = await checkIn('102', '9855000002', { bookingId: booking.id });
    const kot = (await ctx.api().post(`${V1}/kots`).set(staff()).send({ stayId: stay.id, billTo: 'ROOM', items: [{ menuItemId: await ctx.menuId('Veg Thali'), qty: 1 }] }).expect(201)).body.data.kot;
    const req = await ctx.model('ServiceRequest').create({ stayId: stay.id, key: 'laundry', label: 'Laundry pickup' });

    await remove(stay.id).expect(204);
    expect(await ctx.model('Kot').countDocuments({ _id: kot.id })).toBe(0);
    expect(await ctx.model('ServiceRequest').countDocuments({ _id: req._id })).toBe(0);
    const b = (await ctx.model('Booking').findById(booking.id).lean()) as any;
    expect(b.status).toBe('CONFIRMED');
    expect(b.roomLines.every((l: any) => l.stayId === null)).toBe(true);

    const walkIn = await checkIn('103', '9855000003');
    const own = ((await ctx.model('Stay').findById(walkIn.id).lean()) as any).bookingId;
    await remove(walkIn.id).expect(204);
    expect(await ctx.model('Booking').countDocuments({ _id: own })).toBe(0);
  });

  it('a settled bill is 409 STAY_HAS_PAYMENTS; a checked-out stay is 409 STAY_CLOSED', async () => {
    const stay = await checkIn('104', '9855000004');
    const kot = (await ctx.api().post(`${V1}/kots`).set(staff()).send({ stayId: stay.id, billTo: 'PAY_NOW', items: [{ menuItemId: await ctx.menuId('Veg Thali'), qty: 1 }] }).expect(201)).body.data.kot;
    await ctx.api().post(`${V1}/bills/settle`).set(staff()).send({ kotIds: [kot.id], mode: 'CASH', time: '13:00' }).expect(200);
    expect((await remove(stay.id).expect(409)).body.code).toBe('STAY_HAS_PAYMENTS');
    expect(((await ctx.model('Stay').findById(stay.id).lean()) as any).status).toBe('IN_HOUSE');

    const paidService = await checkIn('201', '9855000005');
    const taxi = await ctx.model('ServiceRequest').create({ stayId: paidService.id, key: 'taxi', label: 'Book a taxi' });
    await ctx.api().post(`${V1}/service-requests/${taxi._id}/charge`).set(staff()).send({ amount: '300.00', billTo: 'PAY_NOW', mode: 'CASH', time: '15:00' }).expect(200);
    expect((await remove(paidService.id).expect(409)).body.code).toBe('STAY_HAS_PAYMENTS');

    const out = await checkIn('202', '9855000006');
    await ctx.api().post(`${V1}/stays/${out.id}/checkout`).set(staff()).send({}).expect(200);
    expect((await remove(out.id).expect(409)).body.code).toBe('STAY_CLOSED');
  });

  it('PATCH /stays/:id takes what the edit form sends', async () => {
    const stay = await checkIn('203', '9855000007');
    const res = (await ctx.api().patch(`${V1}/stays/${stay.id}`).set(mgr()).send({
      guestName: 'Edited Name', vehicle: 'MH12AB1234', guests: 2, checkOut: day(3),
      payment: { kind: 'ADVANCE', amount: '250.00', mode: 'UPI', time: '11:00', narration: 'Advance' },
    }).expect(200)).body.data;
    expect(res.stay).toMatchObject({ guestName: 'Edited Name', vehicle: 'MH12AB1234', guests: 2, checkOut: day(3), nights: 3 });
    expect(res.entry).toMatchObject({ amount: 250, mode: 'UPI', dc: 'CREDIT' });
    await ctx.api().patch(`${V1}/stays/${stay.id}`).set(mgr()).send({ guests: 1 }).expect(200);
    await ctx.api().patch(`${V1}/stays/${stay.id}`).set(mgr()).send({ guests: 0 }).expect(400);
  });

  it('an advance from a closed day is reversed on the open day, linked to the original', async () => {
    const stay = await checkIn('204', '9855000008', { advance: { amount: '700.00', mode: 'CASH', time: '09:00' } });
    const original = (await ctx.model('DayRegisterEntry').findOne({ stayId: stay.id }).lean()) as any;
    const closedBefore = await daybook(ctx.today);
    await ctx.api().post(`${V1}/business-day/close`).set(admin()).send({ businessDate: ctx.today, countedCash: '0', note: 'test', time: '23:00' }).expect(200);
    const last = (await ctx.api().get(`${V1}/business-day/current`).set(admin()).expect(200)).body.data.lastClosingBalance;
    await ctx.api().post(`${V1}/business-day/start`).set(admin()).send({ businessDate: day(1), openingBalance: String(last), time: '08:00' }).expect(200);

    const sales = async () => Number((await ctx.api().get(`${V1}/reports/summary`).query({ from: ctx.today, to: day(1) }).set(admin()).expect(200)).body.data.totalSales);
    const salesBefore = await sales();
    await remove(stay.id).expect(204);
    expect(await sales()).toBe(salesBefore - 700);
    // The closed day is untouched; the open day carries the reversal.
    expect(await ctx.model('DayRegisterEntry').countDocuments({ _id: original._id })).toBe(1);
    expect((await daybook(ctx.today)).credits).toBe(closedBefore.credits);
    const reversal = (await ctx.model('DayRegisterEntry').findOne({ reversalOf: original._id }).lean()) as any;
    expect(reversal).toMatchObject({ businessDate: day(1), dc: 'DEBIT', mode: 'CASH', source: 'REFUND', type: 'Stay voided' });
    expect(String(reversal.amount)).toBe('700.00');
    expect((await daybook(day(1))).debits).toBe(700);
  });
});
