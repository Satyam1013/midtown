import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DateQueryDto, pageOf } from '../common/dto/common.dto';
import { conflict } from '../common/errors';
import { Paged } from '../common/interceptors/response.interceptor';
import { DebitCredit, PaymentMode } from '../common/enums';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { TransactionService } from '../database/transaction.service';
import { DaybookService } from '../daybook/daybook.service';
import { LedgerService } from '../entries/ledger.service';
import { EntrySource } from '../entries/schemas/day-register-entry.schema';
import { EventsService } from '../notifications/events.service';
import { BusinessDateService } from '../common/services/business-date.service';
import { dec, pct, toD128, toD128Exact } from '../common/utils/money';
import { CreateOnlineOrderDto } from './dto/online-order.dto';
import { OnlineOrder } from './schemas/online-order.schema';

@Injectable()
export class OnlineOrdersService {
  constructor(
    @InjectModel(OnlineOrder.name) private readonly orders: Model<OnlineOrder>,
    private readonly dates: BusinessDateService,
    private readonly tx: TransactionService,
    private readonly daybook: DaybookService,
    private readonly ledger: LedgerService,
    private readonly events: EventsService,
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

  /** The order and its payout's register line (BANK credit), on the open business day. */
  async create(dto: CreateOnlineOrderDto, user: Principal) {
    try {
      return await this.tx.run(async ({ session, afterCommit }) => {
        const businessDate = await this.daybook.requireOpenDay(session);
        const payout = dec(dto.amount).minus(pct(dto.amount, dto.commissionPct));
        const { businessDate: _ignored, ...fields } = dto;
        const [order] = await this.orders.create(
          [
            {
              ...fields,
              businessDate,
              items: dto.items.map((i) => ({ ...i, price: toD128(i.price) })),
              amount: toD128(dto.amount),
              commissionPct: toD128Exact(dto.commissionPct),
              payout: toD128(payout),
            },
          ],
          { session },
        );
        const entry = await this.ledger.post(
          {
            businessDate,
            time: this.dates.nowTime(),
            guestName: dto.platform,
            type: 'Online order',
            mode: PaymentMode.BANK,
            dc: DebitCredit.CREDIT,
            amount: payout.toFixed(2),
            narration: `${dto.platform} ${dto.orderId}: payout after ${dec(dto.commissionPct).toString()}% commission`,
            source: EntrySource.ONLINE,
            createdByUserId: userObjectId(user),
          },
          session,
        );
        order.entryId = entry._id;
        await order.save({ session });
        afterCommit(() => this.events.toHotel('entry.created', { id: String(entry._id), businessDate }));
        return order;
      });
    } catch (err: any) {
      if (err?.code === 11000 && /platform|orderId/.test(String(err.message))) {
        throw conflict('ORDER_EXISTS', 'This order has already been added');
      }
      throw err;
    }
  }
}
