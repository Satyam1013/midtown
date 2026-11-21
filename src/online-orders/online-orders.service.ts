import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { DayRegisterEntry } from '../entries/schemas/day-register-entry.schema';
import { DateQueryDto, pageOf } from '../common/dto/common.dto';
import { conflict, notFound } from '../common/errors';
import { Paged } from '../common/interceptors/response.interceptor';
import { DebitCredit, PaymentMode } from '../common/enums';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { TransactionService } from '../database/transaction.service';
import { DaybookService } from '../daybook/daybook.service';
import { LedgerService } from '../entries/ledger.service';
import { EntrySource } from '../entries/schemas/day-register-entry.schema';
import { EventsService } from '../notifications/events.service';
import { BusinessDateService } from '../common/services/business-date.service';
import { toD128 } from '../common/utils/money';
import { CreateOnlineOrderDto } from './dto/online-order.dto';
import { OnlineOrder, OnlineOrderStatus } from './schemas/online-order.schema';

@Injectable()
export class OnlineOrdersService {
  constructor(
    @InjectModel(OnlineOrder.name) private readonly orders: Model<OnlineOrder>,
    private readonly dates: BusinessDateService,
    private readonly tx: TransactionService,
    private readonly daybook: DaybookService,
    private readonly ledger: LedgerService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
    @InjectModel(DayRegisterEntry.name) private readonly entries: Model<DayRegisterEntry>,
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

  /** The order and its register line (BANK credit of the order value), on the open business day. */
  async create(dto: CreateOnlineOrderDto, user: Principal) {
    try {
      return await this.tx.run(async ({ session, afterCommit }) => {
        const businessDate = await this.daybook.requireOpenDay(session);
        const time = this.dates.nowTime();
        const [order] = await this.orders.create(
          [
            {
              platform: dto.platform,
              orderId: dto.orderId,
              businessDate,
              time,
              items: dto.items.map((i) => ({ ...i, price: toD128(i.price) })),
              amount: toD128(dto.amount),
              status: dto.status ?? OnlineOrderStatus.PREPARING,
              commissionPct: null,
              payout: null,
            },
          ],
          { session },
        );
        const entry = await this.ledger.post(
          {
            businessDate,
            time,
            guestName: dto.platform,
            type: 'Online order',
            mode: PaymentMode.BANK,
            dc: DebitCredit.CREDIT,
            amount: dto.amount,
            narration: `${dto.platform} ${dto.orderId}`,
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

  /**
   * PREPARING → PICKED_UP → DELIVERED (steps may be skipped); PREPARING or
   * PICKED_UP → CANCELLED. DELIVERED and CANCELLED are final: 409 ORDER_CLOSED.
   * Cancelling takes the money back: the receipt is voided if it is on the open
   * day, else an opposite line linked to it (reversalOf) is posted on the open day.
   */
  async setStatus(id: Types.ObjectId, status: OnlineOrderStatus, user: Principal) {
    const order = await this.tx.run(async ({ session, afterCommit }) => {
      const o = await this.orders.findById(id).session(session);
      if (!o) throw notFound('Online order');
      const from = o.status as OnlineOrderStatus;
      if (from === OnlineOrderStatus.DELIVERED || from === OnlineOrderStatus.CANCELLED) {
        throw conflict('ORDER_CLOSED', `This order is ${from.toLowerCase()} and can no longer change`);
      }
      if (status === from) return o;
      const RANK = [OnlineOrderStatus.PREPARING, OnlineOrderStatus.PICKED_UP, OnlineOrderStatus.DELIVERED];
      if (status !== OnlineOrderStatus.CANCELLED && RANK.indexOf(status) < RANK.indexOf(from)) {
        throw conflict('INVALID_STATUS_CHANGE', `An order can't go back from ${from} to ${status}`);
      }

      let reversalId: Types.ObjectId | null = null;
      if (status === OnlineOrderStatus.CANCELLED && o.entryId) {
        const receipt = await this.entries.findById(o.entryId).session(session);
        if (receipt) {
          const openDate = await this.daybook.openDate();
          if (receipt.businessDate === openDate) {
            await this.ledger.softDelete(receipt, session);
          } else {
            // A closed day is never edited: take the money back on the open day.
            const businessDate = await this.daybook.requireOpenDay(session);
            const reversal = await this.ledger.post(
              {
                businessDate,
                time: this.dates.nowTime(),
                guestName: o.platform,
                type: 'Online order cancelled',
                mode: receipt.mode,
                dc: DebitCredit.DEBIT,
                amount: receipt.amount.toString(),
                narration: `${o.platform} ${o.orderId} cancelled; reverses the receipt of ${receipt.businessDate}`,
                source: EntrySource.ONLINE,
                createdByUserId: userObjectId(user),
                dupCheck: false,
              },
              session,
            );
            await this.entries.updateOne({ _id: reversal._id }, { $set: { reversalOf: receipt._id } }, { session });
            reversalId = reversal._id;
            afterCommit(() => this.events.toHotel('entry.created', { id: String(reversal._id), businessDate }));
          }
        }
      }
      o.status = status;
      await o.save({ session });
      await this.audit.record(
        AuditAction.ONLINE_ORDER_STATUS,
        null,
        userObjectId(user),
        { orderId: String(o._id), platform: o.platform, platformOrderId: o.orderId, from, to: status, amount: o.amount, reversalId },
        session,
        o.businessDate,
      );
      return o;
    });
    this.events.toHotel('online-order.updated', { id: String(order._id), status: order.status });
    return this.orders.findById(id).lean();
  }
}
