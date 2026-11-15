import { bearer, bootApp, Ctx } from './helpers';

const V1 = '/api/v1';
let ctx: Ctx;
const rooms: Record<string, string> = {};

beforeAll(async () => {
  ctx = await bootApp();
  for (const number of ['501', '502', '503', '504']) {
    const res = await ctx.api().post(`${V1}/rooms`).set(bearer(ctx.token.MANAGER))
      .send({ number, floor: 5, category: 'AC', roomType: 'AC Standard', singleRate: '1000.00', doubleRate: '1500.00' })
      .expect(201);
    rooms[number] = res.body.data.id;
  }
});

afterAll(async () => {
  await ctx.app.close();
});

const staff = () => bearer(ctx.token.STAFF);
const mgr = () => bearer(ctx.token.MANAGER);
const day = (n: number) => {
  const d = new Date(`${ctx.today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const checkIn = async (room: string, body: object) =>
  (await ctx.api().post(`${V1}/stays`).set(staff()).send({ roomId: rooms[room], nights: 2, ...body }).expect(201)).body.data;
const checkout = async (stayId: string, amount = '0') =>
  (await ctx.api().post(`${V1}/stays/${stayId}/checkout`).set(staff()).send({ payment: { amount, mode: 'CASH', time: '11:00' } }).expect(200)).body.data;
const vacate = (room: string) => ctx.model('Room').updateOne({ _id: rooms[room] }, { $set: { status: 'VACANT' } });
const tariffTotal = async (stayId: string) =>
  (await ctx.model('FolioLine').find({ stayId, source: 'TARIFF' }).lean()).reduce((s: number, l: any) => s + Number(l.amount.toString()), 0);
const upload = (customerId: string, file: Buffer, name: string, type = 'AADHAAR', number?: string) => {
  const req = ctx.api().post(`${V1}/customers/${customerId}/documents`).set(staff()).field('type', type);
  if (number) req.field('number', number);
  return req.attach('file', file, name);
};

describe('Customers', () => {
  let customerId: string;

  it('lookup returns null for a new phone (200)', async () => {
    const res = await ctx.api().get(`${V1}/customers/lookup`).query({ phone: '+91 98111 22333' }).set(staff()).expect(200);
    expect(res.body.data).toEqual({ customer: null });
  });

  it('check-in creates the customer and links the stay', async () => {
    const out = await checkIn('501', { guestName: 'Asha Rao', phone: '+91 98111 22333', guests: 1 });
    customerId = out.customer.id;
    expect(out.stay.customerId).toBe(customerId);
    const look = (await ctx.api().get(`${V1}/customers/lookup`).query({ phone: '9811122333' }).set(staff()).expect(200)).body.data;
    expect(look.customer).toMatchObject({ id: customerId, name: 'Asha Rao', phone: '9811122333', visits: 1, hasDocument: false });
    await checkout(out.stay.id, String(1000 * 2 * 1.05));
    await vacate('501');
  });

  it('upload: real images and PDFs only, 5 MB at most', async () => {
    const fake = await upload(customerId, Buffer.from('this is just text pretending to be a picture'), 'id.jpg').expect(400);
    expect(fake.body.code).toBe('UNSUPPORTED_FILE');
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    await upload(customerId, big, 'big.png').expect(413);
    await upload(customerId, PNG, 'id.png', 'PASSPORT_X').expect(400);
    const ok = (await upload(customerId, PNG, 'aadhaar.jpg', 'AADHAAR', '1234 5678 9012').expect(201)).body.data;
    expect(ok).toMatchObject({ type: 'AADHAAR', numberLast4: '9012', mimeType: 'image/png', fileName: 'aadhaar.jpg' });
    expect(ok.fileUrl).toMatch(/^\/api\/v1\/files\/customer-documents\/.+\?exp=\d+&u=.+&sig=.+/);
  });

  it('a returning customer matched by phone is not duplicated and keeps the document', async () => {
    const out = await checkIn('502', { guestName: 'Asha R.', phone: '09811122333' });
    expect(out.customer.id).toBe(customerId);
    expect(await ctx.model('Customer').countDocuments({ phone: '9811122333' })).toBe(1);
    const look = (await ctx.api().get(`${V1}/customers/lookup`).query({ phone: '9811122333' }).set(staff())).body.data;
    expect(look.customer).toMatchObject({ visits: 2, hasDocument: true, documentType: 'AADHAAR', name: 'Asha Rao' });
    // Picked from lookup by id: still the same customer.
    await checkout(out.stay.id, String(1000 * 2 * 1.05));
    await vacate('502');
    const again = await checkIn('502', { guestName: 'Asha Rao', customerId });
    expect(again.customer.id).toBe(customerId);
    await checkout(again.stay.id, String(1000 * 2 * 1.05));
    await vacate('502');
  });

  it('list and detail never expose the full ID number; the file is behind a signed link', async () => {
    const list = await ctx.api().get(`${V1}/customers`).query({ search: '98111', filter: 'repeat' }).set(staff()).expect(200);
    expect(list.body.data).toEqual([expect.objectContaining({ id: customerId, visits: 3, hasDocument: true, documentType: 'AADHAAR' })]);
    const detail = await ctx.api().get(`${V1}/customers/${customerId}`).set(staff()).expect(200);
    const docs = await ctx.api().get(`${V1}/customers/${customerId}/documents`).set(staff()).expect(200);
    for (const body of [list.text, detail.text, docs.text]) expect(body).not.toMatch(/1234\s?5678\s?9012|567890/);
    const d = detail.body.data;
    expect(d.stays).toHaveLength(3);
    expect(d.stays[0]).toMatchObject({ roomType: 'AC Standard', nights: 2, total: 2100, paid: 2100, balance: 0, status: 'CHECKED_OUT' });
    expect(d.payments.length).toBeGreaterThanOrEqual(3);
    expect(d.totalSpent).toBe(6300);

    const url: string = d.documents[0].fileUrl;
    const file = await ctx.api().get(url).expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['cache-control']).toContain('no-store');
    await ctx.api().get(url.replace(/sig=[^&]+/, 'sig=AAAA')).expect(403);
    await ctx.api().get(url.replace(/u=[^&]+/, `u=${'0'.repeat(24)}`)).expect(403);
    expect(await ctx.model('AuditLog').countDocuments({ action: 'DOCUMENT_VIEW' })).toBe(1);
    expect(await ctx.model('AuditLog').countDocuments({ action: 'DOCUMENT_UPLOAD' })).toBe(1);
  });

  it('nodoc filter, edit, phone clash 409, and merge', async () => {
    const other = await checkIn('503', { guestName: 'Ravi', phone: '9822200000' });
    await checkout(other.stay.id, '2100');
    await vacate('503');
    const nodoc = (await ctx.api().get(`${V1}/customers`).query({ filter: 'nodoc' }).set(staff()).expect(200)).body.data;
    expect(nodoc.map((c: any) => c.id)).toContain(other.customer.id);
    expect(nodoc.map((c: any) => c.id)).not.toContain(customerId);

    const clash = await ctx.api().patch(`${V1}/customers/${other.customer.id}`).set(staff()).send({ phone: '98111 22333' }).expect(409);
    expect(clash.body).toMatchObject({ code: 'CUSTOMER_PHONE_EXISTS', existingCustomerId: customerId });
    await ctx.api().patch(`${V1}/customers/${other.customer.id}`).set(staff()).send({ name: 'Ravi Kumar', email: 'ravi@example.com' }).expect(200);

    await ctx.api().post(`${V1}/customers/${other.customer.id}/merge`).set(staff()).send({ intoCustomerId: customerId }).expect(403);
    const merged = (await ctx.api().post(`${V1}/customers/${other.customer.id}/merge`).set(mgr()).send({ intoCustomerId: customerId }).expect(200)).body.data;
    expect(merged).toMatchObject({ visits: 4, phone: '9811122333', documentCount: 1 });
    await ctx.api().get(`${V1}/customers/${other.customer.id}`).set(staff()).expect(404);
    expect(await ctx.model('Stay').countDocuments({ customerId })).toBe(4);
  });

  it('only a manager deletes a document, and it is audited', async () => {
    const doc = (await ctx.api().get(`${V1}/customers/${customerId}/documents`).set(staff())).body.data[0];
    await ctx.api().delete(`${V1}/customers/${customerId}/documents/${doc.id}`).set(staff()).expect(403);
    await ctx.api().delete(`${V1}/customers/${customerId}/documents/${doc.id}`).set(mgr()).expect(200);
    const look = (await ctx.api().get(`${V1}/customers/lookup`).query({ phone: '9811122333' }).set(staff())).body.data;
    expect(look.customer).toMatchObject({ hasDocument: false, documentType: null });
    expect(await ctx.model('AuditLog').countDocuments({ action: 'DOCUMENT_DELETE' })).toBe(1);
  });
});

describe('Add guest to a stay', () => {
  it('1→2 uses the double rate, 2→3 adds 300 a night, 4→5 is rejected; checkout reflects the segments', async () => {
    const { stay } = await checkIn('504', { guestName: 'Meera', phone: '9833300000', guests: 1, nights: 3, businessDate: day(-1) });
    const add = (body: object) => ctx.api().post(`${V1}/stays/${stay.id}/guests`).set(staff()).send({ businessDate: ctx.today, time: '18:00', ...body });

    const one = (await add({ name: 'Arjun', phone: '9833300001', guests: 2, rate: '1.00' }).expect(201)).body.data;
    expect(one.stay).toMatchObject({ guests: 2, rate: 1500 });
    expect(one.adjustment).toBe(1000); // (1500 − 1000) × 2 nights left
    expect(one.guest.customerId).toBeTruthy();
    expect(one.stay.roomCharges.map((c: any) => [c.guests, c.rate, c.nights])).toEqual([[1, 1000, 1], [2, 1500, 2]]);

    const two = (await add({ name: 'Kid', guests: 3 }).expect(201)).body.data;
    expect(two).toMatchObject({ adjustment: 600, guest: { customerId: null } }); // 300 × 2
    expect(two.stay.roomCharges.map((c: any) => [c.guests, c.rate, c.nights])).toEqual([[1, 1000, 1], [3, 1800, 2]]);

    await add({ guests: 3 }).expect(400);
    await add({ guests: 4 }).expect(201);
    expect((await add({ guests: 5 }).expect(409)).body.code).toBe('GUEST_LIMIT');

    const room = (await ctx.api().get(`${V1}/rooms`).set(staff())).body.data.find((r: any) => r.number === '504');
    expect(room.currentStay.guestList.map((g: any) => [g.name, g.guestsAfter])).toEqual([['Arjun', 2], ['Kid', 3], ['', 4]]);
    expect(await ctx.model('AuditLog').countDocuments({ stayId: stay.id, action: 'GUEST_ADDED' })).toBe(3);
    expect(await ctx.model('DayRegisterEntry').countDocuments({ stayId: stay.id })).toBe(0);

    const total = (1000 + 2100 * 2) * 1.05;
    expect(await tariffTotal(stay.id)).toBeCloseTo(total);
    const out = await checkout(stay.id, '5000.00');
    expect(out.bill).toMatchObject({ roomCharges: total.toFixed(2), payments: '5000.00', total: (total - 5000).toFixed(2) });
    expect(out.shortfall).toBeCloseTo(total - 5000);
    await vacate('504');
  });

  it('adding a guest on the check-out date adjusts 0', async () => {
    const { stay } = await checkIn('504', { guestName: 'Late Add', guests: 1, nights: 2, businessDate: day(-2) });
    const before = await tariffTotal(stay.id);
    const res = (await ctx.api().post(`${V1}/stays/${stay.id}/guests`).set(staff()).send({ name: 'Friend', guests: 2, businessDate: ctx.today }).expect(201)).body.data;
    expect(res.adjustment).toBe(0);
    expect(await tariffTotal(stay.id)).toBeCloseTo(before);
    await ctx.api().post(`${V1}/stays/${stay.id}/guests`).set(staff()).send({ guests: 3, businessDate: day(1) }).expect(400);
  });
});
