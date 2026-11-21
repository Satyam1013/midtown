import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { Staff } from '../staff/schemas/staff.schema';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { badRequest, conflict, notFound } from '../common/errors';
import { DebitCredit } from '../common/enums';
import { pageOf } from '../common/dto/common.dto';
import { Paged } from '../common/interceptors/response.interceptor';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { oid, oidOrNull } from '../common/pipes/parse-object-id.pipe';
import { BusinessDateService } from '../common/services/business-date.service';
import { GstService } from '../common/services/gst.service';
import { TaxService } from '../common/services/tax.service';
import { dec, sum, toD128 } from '../common/utils/money';
import { CounterService } from '../database/counter.service';
import { TransactionService } from '../database/transaction.service';
import { DaybookService } from '../daybook/daybook.service';
import { LedgerService } from '../entries/ledger.service';
import { EntrySource } from '../entries/schemas/day-register-entry.schema';
import { FolioLine, FolioSource } from '../folio/schemas/folio-line.schema';
import { MenuItem } from '../menu/schemas/menu-item.schema';
import { EventsService } from '../notifications/events.service';
import { Stay, StayStatus } from '../stays/schemas/stay.schema';
import { withStayLabels } from '../stays/stay-labels';
import { KotItemDto, KotQueryDto, SettleBillDto } from './dto/kot.dto';
import { Kot, KotBillTo, KotSource, KotStatus } from './schemas/kot.schema';

const STATUS_ORDER = [KotStatus.PLACED, KotStatus.PREPARING, KotStatus.READY, KotStatus.ON_THE_WAY, KotStatus.SERVED];
const CLOSED = [KotStatus.SERVED, KotStatus.CANCELLED];

/** The short number printed on the ticket, e.g. K-0042. */
export const kotLabel = (n: number) => `K-${String(n).padStart(4, '0')}`;

export interface PlaceKot {
  stayId: Types.ObjectId | null;
  tableLabel?: string | null;
  items: KotItemDto[];
  waiterId?: string | null;
  billTo: KotBillTo;
  source: KotSource;
  note?: string;
}

// Front desk KOTs and guest orders are the same thing, created here.
@Injectable()
export class KotsService {
  constructor(
    @InjectModel(Kot.name) private readonly kots: Model<Kot>,
    @InjectModel(MenuItem.name) private readonly menu: Model<MenuItem>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    @InjectModel(FolioLine.name) private readonly folio: Model<FolioLine>,
    private readonly tx: TransactionService,
    private readonly counters: CounterService,
    private readonly tax: TaxService,
    private readonly ledger: LedgerService,
    private readonly daybook: DaybookService,
    private readonly dates: BusinessDateService,
    private readonly events: EventsService,
    private readonly gst: GstService,
    private readonly audit: AuditService,
    @InjectModel(Staff.name) private readonly staffModel: Model<Staff>,
  ) {}

  /**
   * Newest first. One business day: `date`, else the open day (else today); an
   * ADMIN asking for one stay's KOTs gets every day. Non-admins are held to the
   * open day by @OpenDayOnly before this runs.
   */
  async list(q: KotQueryDto) {
    const { page, limit, skip } = pageOf(q);
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.stayId) filter.stayId = new Types.ObjectId(q.stayId);
    if (q.date || !q.stayId) filter.businessDate = q.date ?? (await this.daybook.openDate()) ?? this.dates.today();
    const [items, total] = await Promise.all([
      this.kots.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      this.kots.countDocuments(filter),
    ]);
    const waiters = await this.staffModel.find({ _id: { $in: items.map((k) => k.waiterId).filter(Boolean) } }).select('name').lean();
    const waiterName = new Map(waiters.map((w) => [String(w._id), w.name]));
    const rows = (await withStayLabels(this.stays, items)).map((k) => ({
      ...k,
      displayNumber: kotLabel(k.number),
      waiterName: k.waiterId ? (waiterName.get(String(k.waiterId)) ?? null) : null,
    }));
    return new Paged(rows, { page, limit, total });
  }

  listForStay(stayId: Types.ObjectId) {
    return this.kots.find({ stayId }).sort({ createdAt: -1 }).lean();
  }

  async place(input: PlaceKot) {
    if (input.billTo === KotBillTo.ROOM && !input.stayId) {
      throw badRequest('STAY_REQUIRED', 'A room charge needs a stay');
    }
    if (!input.stayId && !input.tableLabel) throw badRequest('TABLE_REQUIRED', 'A KOT needs a stay or a table');

    return this.tx.run(async ({ session, afterCommit }) => {
      if (input.stayId) {
        const stay = await this.stays
          .findOne({ _id: input.stayId, status: StayStatus.IN_HOUSE })
          .select('_id')
          .session(session)
          .lean();
        if (!stay) throw conflict('STAY_NOT_IN_HOUSE', 'That stay is not in house');
      }

      const lines = await this.priceItems(input.items, session);
      const bill = this.gst.food(sum(lines.map((l) => dec(l.price).times(l.qty))));
      const number = await this.counters.next('kot', session);
      const businessDate = (await this.daybook.openDate()) ?? this.dates.today();
      const [kot] = await this.kots.create(
        [
          {
            number,
            businessDate,
            stayId: input.stayId,
            tableLabel: input.tableLabel || null,
            items: lines,
            taxable: toD128(bill.taxable),
            cgst: toD128(bill.cgst),
            sgst: toD128(bill.sgst),
            total: toD128(bill.total),
            waiterId: oidOrNull(input.waiterId),
            billTo: input.billTo,
            source: input.source,
            note: input.note ?? '',
          },
        ],
        { session },
      );

      if (input.billTo === KotBillTo.ROOM) {
        await this.folio.create(
          [
            {
              stayId: input.stayId,
              head: `Food: KOT #${number}`,
              amount: kot.total,
              source: FolioSource.FOOD,
              kotId: kot._id,
              gstPct: this.gst.settings.foodPct,
              taxable: kot.taxable,
              cgst: kot.cgst,
              sgst: kot.sgst,
            },
          ],
          { session },
        );
      }

      afterCommit(() => {
        const payload = { id: String(kot._id), number: kot.number, status: kot.status };
        if (kot.stayId) {
          this.events.toHotelAndStay('kot.created', kot.stayId, payload);
          if (kot.billTo === KotBillTo.ROOM) {
            this.events.toHotelAndStay('folio.updated', kot.stayId, { stayId: String(kot.stayId) });
          }
        } else {
          this.events.toHotel('kot.created', payload);
        }
      });
      return { kot };
    });
  }

  /**
   * Forward only (PLACED → PREPARING → READY → ON_THE_WAY → SERVED, steps may be
   * skipped), or CANCELLED from anything not yet served. SERVED and CANCELLED are
   * final: 409 KOT_CLOSED. Cancelling a ROOM KOT removes its folio charge; a paid
   * PAY_NOW KOT can't be cancelled (409 KOT_SETTLED: refund it instead).
   */
  async setStatus(id: Types.ObjectId, status: KotStatus, user: Principal) {
    const kot = await this.tx.run(async ({ session }) => {
      const k = await this.kots.findById(id).session(session);
      if (!k) throw notFound('KOT');
      const from = k.status;
      if (CLOSED.includes(from)) throw conflict('KOT_CLOSED', `This KOT is ${from.toLowerCase()} and can no longer change`);
      if (status !== KotStatus.CANCELLED && STATUS_ORDER.indexOf(status) <= STATUS_ORDER.indexOf(from)) {
        throw conflict('INVALID_KOT_STATUS', `A ${from} KOT can't move to ${status}`);
      }
      let folioRemoved: unknown = null;
      if (status === KotStatus.CANCELLED) {
        if (k.billTo === KotBillTo.PAY_NOW && k.settledAt) {
          throw conflict('KOT_SETTLED', 'This KOT has been paid; refund it instead of cancelling');
        }
        if (k.billTo === KotBillTo.ROOM && k.stayId) {
          const stay = await this.stays.findById(k.stayId).select('status').session(session).lean();
          if (stay && stay.status !== StayStatus.IN_HOUSE) {
            throw conflict('KOT_BILLED', 'The guest has checked out; this charge is on a closed bill');
          }
          const line = await this.folio.findOneAndUpdate({ kotId: k._id }, { $set: { deletedAt: new Date() } }, { session });
          folioRemoved = line?.amount ?? null;
        }
      }
      k.status = status;
      await k.save({ session });
      await this.audit.record(
        AuditAction.KOT_STATUS,
        k.stayId ?? null,
        userObjectId(user),
        { kotId: String(k._id), number: k.number, from, to: status, billTo: k.billTo, total: k.total, folioRemoved },
        session,
        k.businessDate ?? null,
      );
      return k;
    });
    const payload = { id: String(kot._id), number: kot.number, status: kot.status };
    if (kot.stayId) this.events.toHotelAndStay('kot.updated', kot.stayId, payload);
    else this.events.toHotel('kot.updated', payload);
    return kot;
  }

  /** Settles PAY_NOW KOTs; the amount comes from the KOTs, never the client. */
  async settle(dto: SettleBillDto, user: Principal) {
    return this.tx.run(async ({ session, afterCommit }) => {
      const businessDate = await this.daybook.requireOpenDay(session);
      const ids = dto.kotIds.map(oid);
      const kots = await this.kots.find({ _id: { $in: ids } }).session(session);
      if (kots.length !== new Set(dto.kotIds).size) throw notFound('KOT');
      for (const kot of kots) {
        if (kot.billTo !== KotBillTo.PAY_NOW) throw conflict('KOT_ON_ROOM_BILL', `KOT #${kot.number} is on the room bill`);
        if (kot.settledAt) throw conflict('KOT_ALREADY_SETTLED', `KOT #${kot.number} is already settled`);
        if (kot.status === KotStatus.CANCELLED) throw conflict('KOT_CANCELLED', `KOT #${kot.number} was cancelled`);
      }

      const total = sum(kots.map((k) => k.total));
      const label = kots[0].tableLabel ?? `KOT #${kots.map((k) => k.number).join(', #')}`;
      const entry = await this.ledger.post(
        {
          businessDate,
          time: dto.time,
          guestName: label,
          // Room-service orders paid on delivery count apart from the restaurant.
          source: kots.every((k) => k.stayId) ? EntrySource.ROOM_SERVICE : EntrySource.RESTAURANT,
          type: kots.every((k) => k.stayId) ? 'Room service' : 'Restaurant',
          mode: dto.mode,
          dc: DebitCredit.CREDIT,
          amount: total.toFixed(2),
          narration: `Bill: KOT #${kots.map((k) => k.number).join(', #')}`,
          createdByUserId: userObjectId(user),
        },
        session,
      );
      await this.kots.updateMany({ _id: { $in: ids } }, { $set: { settledAt: new Date() } }, { session });
      afterCommit(() => this.events.toHotel('entry.created', { id: String(entry._id), businessDate: entry.businessDate }));
      // Table bills carry the CGST + SGST of their KOTs.
      return {
        entry,
        gstPct: this.gst.settings.foodPct,
        sac: this.gst.settings.sac.FOOD,
        gstin: this.gst.settings.gstin || null,
        taxable: sum(kots.map((k) => k.taxable)).toFixed(2),
        cgst: sum(kots.map((k) => k.cgst)).toFixed(2),
        sgst: sum(kots.map((k) => k.sgst)).toFixed(2),
        total: total.toFixed(2),
      };
    });
  }

  /** Prices come from the menu in the database, whatever the client believes. */
  private async priceItems(items: KotItemDto[], session: ClientSession) {
    const menu = await this.menu.find({ _id: { $in: items.map((i) => i.menuItemId) } }).session(session).lean();
    const byId = new Map(menu.map((m) => [String(m._id), m]));
    return items.map((item) => {
      const dish = byId.get(item.menuItemId);
      if (!dish) throw notFound('Menu item');
      if (!dish.available) throw conflict('ITEM_UNAVAILABLE', `${dish.name} is not available right now`);
      return { menuItemId: dish._id, name: dish.name, price: dish.price, qty: item.qty, note: item.note ?? '' };
    });
  }
}
