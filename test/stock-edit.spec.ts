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
const create = async (item: string, unit = 'kg', qty = '10') =>
  (await ctx.api().post(`${V1}/stock`).set(staff()).send({ item, category: 'Kitchen', unit, qty, minQty: '2', rate: '50' }).expect(201)).body.data;
const list = async () => (await ctx.api().get(`${V1}/stock`).set(staff()).expect(200)).body.data;

describe('Stock edit and delete', () => {
  it('any unit text is kept as sent', async () => {
    for (const unit of ['qty', 'bottle', 'bag', 'carton', 'can', 'roll', 'set', 'pair', 'metre']) {
      const it = await create(`Item ${unit}`, unit, '0');
      expect(it.unit).toBe(unit);
    }
    const one = (await list()).find((x: any) => x.item === 'Item metre');
    const res = (await ctx.api().patch(`${V1}/stock/${one.id}`).set(mgr()).send({ unit: 'carton' }).expect(200)).body.data;
    expect(res.unit).toBe('carton');
  });

  it('a new qty is recorded as an ADJUSTMENT movement of the difference; the response matches GET /stock', async () => {
    const it = await create('Rice', 'kg', '10');
    const res = (await ctx.api().patch(`${V1}/stock/${it.id}`).set(mgr()).send({ qty: '7.5', minQty: '3', rate: '55', category: 'Grains' }).expect(200)).body.data;
    expect(res).toMatchObject({ item: 'Rice', qty: 7.5, minQty: 3, rate: 55, category: 'Grains' });
    const row = (await list()).find((x: any) => x.id === it.id);
    expect(Object.keys(res).sort()).toEqual(Object.keys(row).sort());
    const moves = (await ctx.model('StockMovement').find({ stockItemId: it.id }).sort({ createdAt: 1 }).lean()) as any[];
    expect(moves.map((m) => [String(m.delta), m.type, m.reason])).toEqual([
      ['10', 'OPENING', 'Opening stock'],
      ['-2.5', 'ADJUSTMENT', 'Edited from inventory page'],
    ]);
    expect(moves[1].userId).toBeTruthy();
    // Same qty: nothing recorded.
    await ctx.api().patch(`${V1}/stock/${it.id}`).set(mgr()).send({ qty: '7.5' }).expect(200);
    expect(await ctx.model('StockMovement').countDocuments({ stockItemId: it.id })).toBe(2);
  });

  it('validation: duplicate name (any case) is 409; negatives are 400; STAFF is 403', async () => {
    await create('Sugar');
    const salt = await create('Salt');
    expect((await ctx.api().patch(`${V1}/stock/${salt.id}`).set(mgr()).send({ item: 'SUGAR' }).expect(409)).body.code).toBe('STOCK_ITEM_EXISTS');
    await ctx.api().patch(`${V1}/stock/${salt.id}`).set(mgr()).send({ item: 'salt' }).expect(200); // its own name, other case
    for (const body of [{ qty: '-1' }, { minQty: '-1' }, { rate: '-1' }, { item: '' }]) {
      await ctx.api().patch(`${V1}/stock/${salt.id}`).set(mgr()).send(body).expect(400);
    }
    await ctx.api().patch(`${V1}/stock/${salt.id}`).set(staff()).send({ rate: '1' }).expect(403);
  });

  it('delete: ADMIN only, 204, gone from the list, history kept, audited; the name can be reused', async () => {
    const oil = await create('Oil', 'litre', '5');
    await ctx.api().post(`${V1}/stock/${oil.id}/adjust`).set(staff()).send({ delta: '-1', reason: 'Used' }).expect(200);
    await ctx.api().delete(`${V1}/stock/${oil.id}`).set(mgr()).expect(403);
    await ctx.api().delete(`${V1}/stock/${oil.id}`).set(admin()).expect(204);
    expect((await list()).some((x: any) => x.id === oil.id)).toBe(false);
    expect(await ctx.model('StockMovement').countDocuments({ stockItemId: oil.id })).toBe(2);
    const log = (await ctx.model('AuditLog').findOne({ action: 'STOCK_DELETE', 'details.stockItemId': oil.id }).lean()) as any;
    expect(log.details).toMatchObject({ item: 'Oil' });
    expect(String(log.details.lastQty)).toBe('4');
    await ctx.api().delete(`${V1}/stock/${oil.id}`).set(admin()).expect(404);
    await ctx.api().post(`${V1}/stock/${oil.id}/adjust`).set(staff()).send({ delta: '1', reason: 'x' }).expect(404);
    await create('Oil');
  });

  it('adjust still refuses to go below zero', async () => {
    const it = await create('Flour', 'kg', '1');
    expect((await ctx.api().post(`${V1}/stock/${it.id}/adjust`).set(staff()).send({ delta: '-2', reason: 'x' }).expect(409)).body.code).toBe('INSUFFICIENT_STOCK');
  });
});
