import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { pageOf } from '../common/dto/common.dto';
import { notFound } from '../common/errors';
import { Paged } from '../common/interceptors/response.interceptor';
import { Principal } from '../common/interfaces/principal';
import { oid, oidOrNull } from '../common/pipes/parse-object-id.pipe';
import { BusinessDateService } from '../common/services/business-date.service';
import { FOOD_GST_PCT, ROOM_GST_PCT, TaxService } from '../common/services/tax.service';
import { dec, sum, toD128, toD128Exact } from '../common/utils/money';
import { CounterService } from '../database/counter.service';
import { TransactionService } from '../database/transaction.service';
import { Stay } from '../stays/schemas/stay.schema';
import { CreateInvoiceDto, InvoiceLineKind, InvoiceQueryDto } from './dto/invoice.dto';
import { Invoice } from './schemas/invoice.schema';

const RULES = {
  [InvoiceLineKind.ROOM]: { gstPct: ROOM_GST_PCT, sac: '996311' },
  [InvoiceLineKind.FOOD]: { gstPct: FOOD_GST_PCT, sac: '996331' },
};

@Injectable()
export class InvoicesService {
  constructor(
    @InjectModel(Invoice.name) private readonly invoices: Model<Invoice>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    private readonly tx: TransactionService,
    private readonly counters: CounterService,
    private readonly tax: TaxService,
    private readonly dates: BusinessDateService,
  ) {}

  async list(q: InvoiceQueryDto) {
    const { page, limit, skip } = pageOf(q);
    const filter = { ...(q.date ? { businessDate: q.date } : {}), ...(q.stayId ? { stayId: oid(q.stayId) } : {}) };
    const [items, total] = await Promise.all([
      this.invoices.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.invoices.countDocuments(filter),
    ]);
    return new Paged(items, { page, limit, total });
  }

  async create(dto: CreateInvoiceDto, user: Principal) {
    this.dates.assertAllowed(dto.businessDate, user);
    if (dto.stayId && !(await this.stays.exists({ _id: dto.stayId }))) throw notFound('Stay');

    const lines = dto.lines.map((line) => {
      const rule = RULES[line.kind];
      const bill = this.tax.breakup(dec(line.qty).times(dec(line.rate)), rule.gstPct);
      return { line, rule, bill };
    });
    return this.tx.run(async ({ session }) => {
      // Numbered inside the transaction: an aborted invoice leaves no gap.
      const seq = await this.counters.next('invoice', session);
      const [invoice] = await this.invoices.create(
        [
          {
            number: `MT-${String(seq).padStart(6, '0')}`,
            businessDate: dto.businessDate,
            party: dto.party,
            partyGstin: dto.partyGstin || null,
            stayId: oidOrNull(dto.stayId),
            lines: lines.map(({ line, rule, bill }) => ({
              description: line.description,
              sac: rule.sac,
              qty: toD128Exact(line.qty),
              rate: toD128(line.rate),
              gstPct: toD128Exact(rule.gstPct),
              taxable: toD128(bill.taxable),
              cgst: toD128(bill.cgst),
              sgst: toD128(bill.sgst),
              total: toD128(bill.total),
            })),
            taxable: toD128(sum(lines.map((l) => l.bill.taxable))),
            cgst: toD128(sum(lines.map((l) => l.bill.cgst))),
            sgst: toD128(sum(lines.map((l) => l.bill.sgst))),
            total: toD128(sum(lines.map((l) => l.bill.total))),
          },
        ],
        { session },
      );
      return invoice;
    });
  }
}
