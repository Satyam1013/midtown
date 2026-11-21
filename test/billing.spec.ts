import { Types } from 'mongoose';
import { bearer, bootApp, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;
const rooms: Record<string, string> = {};

beforeAll(async () => {
  ctx = await bootApp();
  const plan: [string, string, string, string][] = [
    ['601', 'AC Deluxe', '2000.00', '2500.00'],
    ['602', 'AC Deluxe', '2000.00', '2500.00'],
    ['603', 'AC Deluxe', '2000.00', '2500.00'],
    ['604', 'AC Executive', '8000.00', '9000.00'], // above the 7,500 slab
    ['605', 'AC Executive', '3000.00', '3600.00'],
  ];
  for (const [number, roomType, singleRate, doubleRate] of plan) {
    const res = await ctx.api().post(`${V1}/rooms`).set(bearer(ctx.token.ADMIN))
      .send({ number, floor: 6, category: 'AC', roomType, singleRate, doubleRate, features: ['AC', 'TV', 'Wi-Fi'], description: 'Corner room' })
      .expect(201);
    rooms[number] = res.body.data.id;
  }
});

afterAll(async () => {
  await ctx.app.close();
});

const staff = () => bearer(ctx.token.STAFF);
const mgr = () => bearer(ctx.token.MANAGER);
const roomRow = async (n: string) => (await ctx.api().get(`${V1}/rooms`).set(staff())).body.data.find((r: any) => r.number === n);
const checkIn = async (room: string, phone: string, guests = 1, nights = 2) =>
  (await ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId: rooms[room], guestName: `Guest ${room}`, phone, guests, nights }).expect(201)).body.data.stay;
const daybook = async () => (await ctx.api().get(`${V1}/daybook`).query({ date: ctx.today }).set(staff())).body.data;
const vacate = (room: string) => ctx.model('Room').updateOne({ _id: rooms[room] }, { $set: { status: 'VACANT' } });

describe('Maintenance', () => {
  it('takes a vacant room out of check-in, shifts, bookings and availability', async () => {
    const deluxe = async () => (await ctx.api().get(`${V1}/public/room-types`)).body.data.find((t: any) => t.name === 'AC Deluxe');
    const before = await deluxe();
    const set = await ctx.api().patch(`${V1}/rooms/${rooms['601']}/status`).set(staff())
      .send({ status: 'MAINTENANCE', reason: 'AC leaking', expectedBackDate: '2026-12-01' }).expect(200);
    expect(set.body.data).toMatchObject({ status: 'MAINTENANCE', maintenanceReason: 'AC leaking', maintenanceUntil: '2026-12-01' });
    expect(await roomRow('601')).toMatchObject({ status: 'MAINTENANCE', maintenanceReason: 'AC leaking', maintenanceUntil: '2026-12-01', features: ['AC', 'TV', 'Wi-Fi'], description: 'Corner room' });
    const after = await deluxe();
    expect([after.totalRooms, after.availableRooms]).toEqual([before.totalRooms - 1, before.availableRooms - 1]);

    const ci = await ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId: rooms['601'], guestName: 'X', nights: 1 }).expect(409);
    expect(ci.body.code).toBe('ROOM_NOT_VACANT');
    const stay = await checkIn('602', '9700060001');
    expect((await ctx.api().post(`${V1}/stays/${stay.id}/shift`).set(staff()).send({ toRoomId: rooms['601'], guests: 1, businessDate: ctx.today, time: '10:00' }).expect(409)).body.code).toBe('ROOM_NOT_VACANT');
    // It can't be booked while under repair (until the expected back date).
    const booking = await ctx.api().post(`${V1}/bookings`).set(staff())
      .send({ source: 'Walk-in', guestName: 'Group', phone: '9700060009', roomId: rooms['601'], pax: 1, arrivalDate: ctx.today, departureDate: '2026-12-02', amount: '1000' });
    expect([booking.status, booking.body.code]).toEqual([409, 'ROOM_NOT_AVAILABLE']);

    // A room with a guest can't go to maintenance.
    expect((await ctx.api().patch(`${V1}/rooms/${rooms['602']}/status`).set(staff()).send({ status: 'MAINTENANCE' }).expect(409)).body.code).toBe('ROOM_OCCUPIED');
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({ payments: [{ mode: 'CASH', amount: '4200.00', time: '11:00' }] }).expect(200);
    await vacate('602');

    // Back in service: fields cleared, history closed, both changes audited.
    const back = await ctx.api().patch(`${V1}/rooms/${rooms['601']}/status`).set(staff()).send({ status: 'VACANT' }).expect(200);
    expect(back.body.data).toMatchObject({ status: 'VACANT', maintenanceReason: null, maintenanceUntil: null });
    const history = (await ctx.api().get(`${V1}/rooms/maintenance-history`).query({ roomId: rooms['601'] }).set(mgr()).expect(200)).body.data;
    expect(history).toEqual([expect.objectContaining({ reason: 'AC leaking', endedTo: 'VACANT', endedAt: expect.any(String) })]);
    expect(await ctx.model('AuditLog').countDocuments({ action: 'ROOM_STATUS', 'details.roomId': new Types.ObjectId(rooms['601']) })).toBe(2);
  });
});

describe('Room edit', () => {
  it('editing prices leaves a running stay unchanged; features are validated; number locked once used', async () => {
    const stay = await checkIn('603', '9700060002', 2); // 2500
    const before = (await ctx.model('FolioLine').find({ stayId: stay.id, source: 'TARIFF' }).lean()).map((l: any) => l.amount.toString());
    await ctx.api().patch(`${V1}/rooms/${rooms['603']}`).set(bearer(ctx.token.ADMIN)).send({ features: ['Jacuzzi'] }).expect(400);
    const res = await ctx.api().patch(`${V1}/rooms/${rooms['603']}`).set(bearer(ctx.token.ADMIN))
      .send({ singleRate: '2200.00', doubleRate: '2800.00', floor: 7, features: ['AC', 'Balcony'], description: 'Sea-facing' }).expect(200);
    expect(res.body.data).toMatchObject({ singleRate: 2200, doubleRate: 2800, rate: 2200, floor: 7, features: ['AC', 'Balcony'], description: 'Sea-facing' });
    const row = await roomRow('603');
    expect(row.currentStay).toMatchObject({ rate: 2500, guests: 2 });
    expect((await ctx.model('FolioLine').find({ stayId: stay.id, source: 'TARIFF' }).lean()).map((l: any) => l.amount.toString())).toEqual(before);
    expect((await ctx.api().patch(`${V1}/rooms/${rooms['603']}`).set(bearer(ctx.token.ADMIN)).send({ number: '699' }).expect(409)).body.code).toBe('ROOM_HAS_STAYS');
    expect(await ctx.model('AuditLog').countDocuments({ action: 'ROOM_UPDATE', 'details.priceChanged': true })).toBe(1);
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({}).expect(200);
    await vacate('603');
  });
});

describe('Split payment and the bill', () => {
  it('three rows (UPI twice, CASH once) post three lines; bill sections, GST and payments add up', async () => {
    const stay = await checkIn('605', '9700060003', 2, 2); // 3600 × 2 = 7200 + 5% = 7560
    const kot = await ctx.api().post(`${V1}/kots`).set(staff())
      .send({ stayId: stay.id, billTo: 'ROOM', items: [{ menuItemId: await ctx.menuId('Jeera Rice'), qty: 2 }] }).expect(201); // 300 + 5% = 315
    const req = await ctx.model('ServiceRequest').create({ stayId: stay.id, key: 'laundry', label: 'Laundry pickup' });
    await ctx.api().post(`${V1}/service-requests/${req._id}/charge`).set(staff()).send({ amount: '200.00', billTo: 'ROOM' }).expect(200); // + 18% = 236
    expect(kot.body.data.kot).toMatchObject({ taxable: 300, cgst: 7.5, sgst: 7.5, total: 315 });

    const provisional = (await ctx.api().get(`${V1}/stays/${stay.id}/bill`).set(staff()).expect(200)).body.data;
    expect(provisional).toMatchObject({ billNo: null, provisional: true, total: '8111.00' });
    const book0 = await daybook();

    const rows = [
      { mode: 'UPI', amount: '3000.00', time: '10:00' },
      { mode: 'CASH', amount: '2111.00', time: '10:01' },
      { mode: 'UPI', amount: '3000.00', time: '10:02', narration: 'second UPI' },
    ];
    const out = (await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({ businessDate: '2020-01-01', payments: rows }).expect(200)).body.data;
    // Three ledger rows (mode totals), one settlement (the register line).
    expect(out.entries.map((e: any) => [e.type, e.mode, e.amount, e.source])).toEqual([
      ['Check-out', 'UPI', 3000, 'CHECKOUT'],
      ['Check-out', 'CASH', 2111, 'CHECKOUT'],
      ['Check-out', 'UPI', 3000, 'CHECKOUT'],
    ]);
    expect(out.settlement).toMatchObject({ mode: 'MIXED', amount: 8111, billTotal: 8111, shortfall: null, payments: [{ mode: 'UPI', amount: 6000 }, { mode: 'CASH', amount: 2111 }] });
    expect(out.shortfall).toBe(0);
    const book1 = await daybook();
    expect(book1.credits - book0.credits).toBeCloseTo(8111);

    const bill = out.finalBill;
    expect(bill.billNo).toMatch(/^MTH\/\d{4}-\d{2}\/\d{5}$/);
    expect(bill.provisional).toBe(false);
    const sec = (k: string) => bill.sections.find((s: any) => s.key === k);
    expect(sec('STAY')).toMatchObject({ gstRate: 5, sac: '996311', taxable: '7200.00', cgst: '180.00', sgst: '180.00', total: '7560.00' });
    expect(sec('STAY').lines).toEqual([expect.objectContaining({ qty: 2, rate: '3600.00', amount: '7200.00', gstRate: 5 })]);
    expect(sec('FOOD')).toMatchObject({ gstRate: 5, taxable: '300.00', cgst: '7.50', sgst: '7.50', total: '315.00' });
    expect(sec('FOOD').lines).toEqual([expect.objectContaining({ qty: 2, rate: '150.00', amount: '300.00' })]);
    expect(sec('OTHER')).toMatchObject({ gstRate: 18, taxable: '200.00', cgst: '18.00', sgst: '18.00', total: '236.00' });
    for (const s of bill.sections) {
      expect(s.cgst).toBe(s.sgst);
      expect(Number(s.taxable) + Number(s.cgst) + Number(s.sgst)).toBeCloseTo(Number(s.total));
    }
    const sum = (k: string) => bill.sections.reduce((t: number, s: any) => t + Number(s[k]), 0);
    expect([sum('taxable'), sum('cgst'), sum('total')]).toEqual([Number(bill.taxable), Number(bill.cgst), Number(bill.total)]);
    expect(bill.cgst).toBe(bill.sgst);
    expect(bill).toMatchObject({ total: '8111.00', paid: '8111.00', balance: '0.00' });
    expect(bill.payments).toEqual(expect.arrayContaining([{ mode: 'UPI', amount: '6000.00' }, { mode: 'CASH', amount: '2111.00' }]));
    // The bill number is fixed once given.
    expect((await ctx.api().get(`${V1}/stays/${stay.id}/bill`).set(staff())).body.data.billNo).toBe(bill.billNo);
  });

  it('a failed split payment saves nothing', async () => {
    const stay = await checkIn('602', '9700060004');
    const entries0 = await ctx.model('DayRegisterEntry').countDocuments({});
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff())
      .send({ payments: [{ mode: 'UPI', amount: '1000.00', time: '10:00' }, { mode: 'CHEQUE', amount: '500.00', time: '10:00' }] }).expect(400);
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff())
      .send({ payments: [{ mode: 'UPI', amount: '1000.00', time: '10:00' }, { mode: 'CASH', amount: '0', time: '10:00' }] }).expect(400);
    // A failure inside the transaction (the day closed) rolls the rows back too.
    await ctx.model('DayBook').updateOne({ businessDate: ctx.today }, { $set: { status: 'CLOSED' } });
    await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({ payments: [{ mode: 'UPI', amount: '1000.00', time: '10:00' }] }).expect(409);
    await ctx.model('DayBook').updateOne({ businessDate: ctx.today }, { $set: { status: 'OPEN' } });
    expect(await ctx.model('DayRegisterEntry').countDocuments({})).toBe(entries0);
    expect(((await ctx.model('Stay').findById(stay.id).lean()) as any)).toMatchObject({ status: 'IN_HOUSE', billNo: null });

    // Short collection: shortfall on the last row, balance stays on the folio and the customer.
    const out = (await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff())
      .send({ payments: [{ mode: 'UPI', amount: '1000.00', time: '10:00' }, { mode: 'CASH', amount: '1000.00', time: '10:05' }] }).expect(200)).body.data;
    expect(out.shortfall).toBe(2200); // 2000 × 2 × 1.05 = 4200 − 2000
    expect(out.settlement).toMatchObject({ amount: 2000, billTotal: 4200, shortfall: 2200 });
    expect(out.finalBill).toMatchObject({ balance: '2200.00', paid: '2000.00' });
    const customer = (await ctx.api().get(`${V1}/customers/${out.stay.customerId}`).set(staff())).body.data;
    expect(customer.stays[0]).toMatchObject({ balance: 2200 });
    await vacate('602');
  });

  it('rooms above 7,500 a night take 18%; bill numbers are sequential and unique', async () => {
    const stay = await checkIn('604', '9700060005', 1, 1); // 8000 + 18% = 9440
    const out = (await ctx.api().post(`${V1}/stays/${stay.id}/checkout`).set(staff()).send({ payments: [{ mode: 'CARD', amount: '9440.00', time: '12:00' }] }).expect(200)).body.data;
    expect(out.finalBill.sections.find((s: any) => s.key === 'STAY')).toMatchObject({ gstRate: 18, taxable: '8000.00', cgst: '720.00', sgst: '720.00', total: '9440.00' });
    const numbers = (await ctx.model('Stay').find({ billNo: { $ne: null } }).lean()).map((s: any) => s.billNo);
    expect(new Set(numbers).size).toBe(numbers.length);
    const seqs = numbers.map((n: string) => Number(n.split('/')[2])).sort((a: number, b: number) => a - b);
    expect(seqs).toEqual(seqs.map((_: number, i: number) => seqs[0] + i));
    await vacate('604');
  });

  it('a table bill carries CGST + SGST', async () => {
    const kot = await ctx.api().post(`${V1}/kots`).set(staff()).send({ tableLabel: 'Table 6', billTo: 'PAY_NOW', items: [{ menuItemId: await ctx.menuId('Jeera Rice'), qty: 1 }] }).expect(201);
    const res = (await ctx.api().post(`${V1}/bills/settle`).set(staff()).send({ kotIds: [kot.body.data.kot.id], mode: 'CASH', time: '13:00' }).expect(200)).body.data;
    expect(res).toMatchObject({ gstPct: 5, taxable: '150.00', cgst: '3.75', sgst: '3.75', total: '157.50' });
  });
});

describe('Bill prints', () => {
  it('a manual bill print is recorded for audit and changes no totals', async () => {
    const stay = await ctx.model('Stay').findOne({ billNo: { $ne: null }, guestName: 'Guest 605' }).lean() as any;
    const snapshot = async () => ({
      book: await daybook(),
      entries: await ctx.model('DayRegisterEntry').countDocuments({}),
      folio: await ctx.model('FolioLine').countDocuments({}),
      bill: (await ctx.api().get(`${V1}/stays/${stay._id}/bill`).set(staff())).body.data.total,
    });
    const before = await snapshot();
    const res = await ctx.api().post(`${V1}/stays/${stay._id}/bill-prints`).set(staff())
      .send({ type: 'MANUAL', which: 'combined', amounts: { stay: '7000.00', food: '315.00', other: '236.00' }, actualAmounts: { stay: '7560.00', food: '315.00', other: '236.00' } })
      .expect(201);
    expect(res.body.data).toMatchObject({ type: 'MANUAL', difference: { stay: '-560.00', food: '0.00', other: '0.00', total: '-560.00' }, serverAmounts: { total: '8111.00' } });
    expect(await snapshot()).toEqual(before);
    await ctx.api().get(`${V1}/stays/${stay._id}/bill-prints`).set(staff()).expect(403);
    expect((await ctx.api().get(`${V1}/stays/${stay._id}/bill-prints`).set(mgr()).expect(200)).body.data).toHaveLength(1);
    const report = (await ctx.api().get(`${V1}/reports/manual-bills`).query({ date: ctx.today }).set(mgr()).expect(200)).body.data;
    expect(report.rows).toEqual([[expect.any(String), 'STAFF', '605', 'Guest 605', stay.billNo, 'combined', 8111, 7551, -560]]);
    expect(await ctx.model('AuditLog').countDocuments({ action: 'BILL_PRINT' })).toBe(1);
  });
});
