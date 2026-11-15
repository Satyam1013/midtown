import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { DebitCredit, PaymentMode } from '../common/enums';
import { badRequest, conflict, notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { BusinessDateService } from '../common/services/business-date.service';
import { dec, toD128 } from '../common/utils/money';
import { TransactionService } from '../database/transaction.service';
import { DaybookService } from '../daybook/daybook.service';
import { LedgerService } from '../entries/ledger.service';
import { EntrySource } from '../entries/schemas/day-register-entry.schema';
import { EventsService } from '../notifications/events.service';
import { CreditEntryDto } from './dto/customer.dto';
import { CreditKind, CustomerCreditEntry } from './schemas/customer-credit-entry.schema';
import { Customer } from './schemas/customer.schema';

/**
 * Customer credit (udhaar). The balance only moves together with a ledger
 * entry, in one transaction, so it always equals charges − payments.
 */
@Injectable()
export class CustomerCreditService {
  constructor(
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(CustomerCreditEntry.name) private readonly entries: Model<CustomerCreditEntry>,
    private readonly tx: TransactionService,
    private readonly daybook: DaybookService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly dates: BusinessDateService,
    private readonly events: EventsService,
  ) {}

  post(customerId: Types.ObjectId, dto: CreditEntryDto, user: Principal) {
    if (dto.kind === CreditKind.PAYMENT && !dto.mode) throw badRequest('MODE_REQUIRED', 'Choose how the customer paid');
    if (dto.kind === CreditKind.CHARGE && dto.mode) throw badRequest('MODE_NOT_ALLOWED', 'A credit charge moves no money, so it has no mode');
    if (dto.kind === CreditKind.CHARGE && dto.businessDate && !this.dates.isRealDate(dto.businessDate)) {
      throw badRequest('INVALID_DATE', 'businessDate must be a real date');
    }
    return this.tx.run(async ({ session, afterCommit }) => {
      const out =
        dto.kind === CreditKind.CHARGE
          ? await this.charge(customerId, { amount: dto.amount, narration: dto.narration, businessDate: dto.businessDate ?? (await this.daybook.openDate()) ?? this.dates.today(), time: dto.time ?? null }, user, session)
          : await this.payment(customerId, dto, user, session);
      if (out.receipt) afterCommit(() => this.events.toHotel('entry.created', { id: String(out.receipt!._id), businessDate: out.receipt!.businessDate }));
      return { entry: out.entry, creditBalance: out.creditBalance, receipt: out.receipt };
    });
  }

  /** A CHARGE: the customer owes more. Used directly and by check-out. */
  async charge(
    customerId: Types.ObjectId,
    c: { amount: string; narration?: string; businessDate: string; time: string | null; stayId?: Types.ObjectId | null },
    user: Principal,
    session: ClientSession,
  ) {
    const customer = await this.customers.findOneAndUpdate({ _id: customerId }, { $inc: { creditBalance: toD128(c.amount) } }, { new: true, session });
    if (!customer) throw notFound('Customer');
    const [entry] = await this.entries.create(
      [{ customerId, kind: CreditKind.CHARGE, amount: toD128(c.amount), mode: null, narration: c.narration?.trim() ?? '', businessDate: c.businessDate, time: c.time, createdByUserId: userObjectId(user), stayId: c.stayId ?? null }],
      { session },
    );
    await this.audit.record(AuditAction.CUSTOMER_CREDIT, c.stayId ?? null, userObjectId(user), { customerId, kind: 'CHARGE', amount: entry.amount, balanceAfter: customer.creditBalance, entryId: entry._id }, session, c.businessDate);
    return { entry, creditBalance: customer.creditBalance, receipt: null };
  }

  /** A PAYMENT: reduces the balance (never below 0) and posts a receipt on the open business day. */
  private async payment(customerId: Types.ObjectId, dto: CreditEntryDto, user: Principal, session: ClientSession) {
    const businessDate = await this.daybook.requireOpenDay(session);
    const amount = toD128(dto.amount);
    const customer = await this.customers.findOneAndUpdate(
      { _id: customerId, creditBalance: { $gte: amount } },
      { $inc: { creditBalance: toD128(dec(dto.amount).negated()) } },
      { new: true, session },
    );
    if (!customer) {
      const c = await this.customers.findById(customerId).session(session).lean();
      if (!c) throw notFound('Customer');
      throw conflict('CREDIT_EXCEEDED', `The customer owes only ${dec(c.creditBalance).toFixed(2)}`);
    }
    const time = dto.time ?? this.dates.nowTime();
    const receipt = await this.ledger.post(
      {
        businessDate,
        time,
        guestName: customer.name || customer.phone || 'Customer',
        phone: customer.phone ?? '',
        type: 'Credit received',
        mode: dto.mode as PaymentMode,
        dc: DebitCredit.CREDIT,
        amount: dec(dto.amount).toFixed(2),
        narration: dto.narration?.trim() || 'Customer credit payment',
        source: EntrySource.CUSTOMER_CREDIT,
        createdByUserId: userObjectId(user),
      },
      session,
    );
    const [entry] = await this.entries.create(
      [{ customerId, kind: CreditKind.PAYMENT, amount, mode: dto.mode, narration: dto.narration?.trim() ?? '', businessDate, time, createdByUserId: userObjectId(user), entryId: receipt._id }],
      { session },
    );
    await this.audit.record(AuditAction.CUSTOMER_CREDIT, null, userObjectId(user), { customerId, kind: 'PAYMENT', amount, mode: dto.mode, balanceAfter: customer.creditBalance, entryId: entry._id, receiptId: receipt._id }, session, businessDate);
    return { entry, creditBalance: customer.creditBalance, receipt };
  }

  listFor(customerId: Types.ObjectId) {
    return this.entries.find({ customerId }).sort({ createdAt: -1 }).lean();
  }
}
