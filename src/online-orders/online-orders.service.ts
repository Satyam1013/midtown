import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DateQueryDto, pageOf } from '../common/dto/common.dto';
import { conflict } from '../common/errors';
import { Paged } from '../common/interceptors/response.interceptor';
import { Principal } from '../common/interfaces/principal';
import { BusinessDateService } from '../common/services/business-date.service';
import { dec, pct, toD128, toD128Exact } from '../common/utils/money';
import { CreateOnlineOrderDto } from './dto/online-order.dto';
import { OnlineOrder } from './schemas/online-order.schema';

@Injectable()
export class OnlineOrdersService {
  constructor(
    @InjectModel(OnlineOrder.name) private readonly orders: Model<OnlineOrder>,
    private readonly dates: BusinessDateService,
  ) {}

  async list(q: DateQueryDto) {
    const { page, limit, skip } = pageOf(q);
    const filter = q.date ? { businessDate: q.date } : {};
    const [items, total] = await Promise.all([
      this.orders.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.orders.countDocuments(filter),
    ]);
    return new Paged(items, { page, limit, total });
  }

  async create(dto: CreateOnlineOrderDto, user: Principal) {
    this.dates.assertAllowed(dto.businessDate, user);
    try {
      return await this.orders.create({
        ...dto,
        items: dto.items.map((i) => ({ ...i, price: toD128(i.price) })),
        amount: toD128(dto.amount),
        commissionPct: toD128Exact(dto.commissionPct),
        payout: toD128(dec(dto.amount).minus(pct(dto.amount, dto.commissionPct))),
      });
    } catch (err: any) {
      if (err?.code === 11000) throw conflict('ORDER_EXISTS', 'This order has already been added');
      throw err;
    }
  }
}
