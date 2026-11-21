import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { badRequest, notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { oidOrNull } from '../common/pipes/parse-object-id.pipe';
import { BusinessDateService } from '../common/services/business-date.service';
import { toD128 } from '../common/utils/money';
import { DaybookService, sourceOf } from '../daybook/daybook.service';
import { TransactionService } from '../database/transaction.service';
import { EventsService } from '../notifications/events.service';
import { Room } from '../rooms/schemas/room.schema';
import { CreateEntryDto, isWithdraw, UpdateEntryDto, WITHDRAW_TYPE } from './dto/entry.dto';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { DebitCredit, PaymentMode } from '../common/enums';
import { dec } from '../common/utils/money';
import { LedgerService } from './ledger.service';
import { DayRegisterEntry, EntrySource } from './schemas/day-register-entry.schema';

const ORIGIN: Record<EntrySource, string> = {
  MANUAL: 'a manual entry',
  CHECKIN: 'check-in',
  CHECKOUT: 'checkout',
  STAY_PAYMENT: 'a stay payment (Edit stay)',
  RESTAURANT: 'a restaurant bill',
  ROOM_SERVICE: 'a room-service bill',
  ONLINE: 'an online order',
  REQUEST: 'a service request charge',
  REFUND: 'a refund (Edit stay)',
  CUSTOMER_CREDIT: 'a customer credit payment',
  EXPENSE_PAYMENT: 'a payment against a credit expense',
  WITHDRAW: 'a withdrawal',
  LAUNDRY: 'a laundry order',
  OTHER: 'another module',
};

@Injectable()
export class EntriesService {
  constructor(
    @InjectModel(DayRegisterEntry.name) private readonly entries: Model<DayRegisterEntry>,
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    private readonly ledger: LedgerService,
    private readonly daybook: DaybookService,
    private readonly dates: BusinessDateService,
    private readonly tx: TransactionService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  /** The day's entries, with each check-out as one line (its per-mode rows are in `payments`). */
  async list(date: string) {
    const [rows, settled] = await Promise.all([
      this.entries.find({ businessDate: date, settlementId: null }).sort({ time: 1, createdAt: 1 }).lean(),
      this.daybook.settlementRows(date),
    ]);
    return [...rows.map((e) => ({ ...e, source: sourceOf(e), shortfall: e.shortfall ?? null })), ...settled].sort((a: any, b: any) =>
      (a.time || '').localeCompare(b.time || ''),
    );
  }

  /** A manual register line, always on the open business day; any businessDate sent is ignored. */
  async create(dto: CreateEntryDto, user: Principal) {
    this.normalize(dto);
    const roomId = oidOrNull(dto.roomId);
    await this.assertRoom(roomId);
    const openDate = await this.daybook.openDate();
    const key = { businessDate: openDate ?? '', roomId, type: dto.type, amount: dto.amount, guestName: dto.guestName };
    return this.ledger.withDuplicateGuard(key, () =>
      this.tx.run(async ({ session, afterCommit }) => {
        key.businessDate = await this.daybook.requireOpenDay(session);
        const existing = await this.ledger.findDuplicate(key, session);
        if (existing) throw this.ledger.duplicateError(existing._id);
        const { businessDate: _ignored, ...fields } = dto;
        const entry = await this.ledger.post(
          { ...fields, businessDate: key.businessDate, roomId, source: isWithdraw(dto.type) ? EntrySource.WITHDRAW : EntrySource.MANUAL, createdByUserId: userObjectId(user) },
          session,
        );
        if (entry.source === EntrySource.WITHDRAW) {
          await this.audit.record(AuditAction.WITHDRAW, null, userObjectId(user), { entryId: String(entry._id), action: 'CREATE', amount: entry.amount, mode: entry.mode, guestName: entry.guestName }, session, entry.businessDate);
        }
        afterCommit(() => this.events.toHotel('entry.created', { id: String(entry._id), businessDate: entry.businessDate }));
        return entry;
      }),
    );
  }

  async update(id: Types.ObjectId, dto: UpdateEntryDto, user: Principal) {
    const current = await this.entries.findById(id).lean();
    if (!current) throw notFound('Entry');
    await this.daybook.assertOpenDayFor(user, current.businessDate);
    this.normalize(dto, current);
    const roomId = dto.roomId === undefined ? current.roomId : oidOrNull(dto.roomId);
    await this.assertRoom(dto.roomId === undefined ? null : roomId);
    const key = {
      businessDate: current.businessDate,
      roomId,
      type: dto.type ?? current.type,
      amount: dto.amount ?? current.amount.toString(),
      guestName: dto.guestName ?? current.guestName,
    };
    return this.ledger.withDuplicateGuard(
      key,
      () =>
        this.tx.run(async ({ session, afterCommit }) => {
          const entry = await this.entries.findById(id).session(session);
          if (!entry) throw notFound('Entry');
          this.assertManual(entry);
          await this.daybook.assertEditable(entry.businessDate, session);
          const existing = await this.ledger.findDuplicate(key, session, id);
          if (existing) throw this.ledger.duplicateError(existing._id);

          const { amount, roomId: _room, ...fields } = dto;
          entry.set(fields);
          if (dto.guestName !== undefined) entry.guestName = dto.guestName.trim();
          if (dto.roomId !== undefined) entry.roomId = roomId;
          if (amount !== undefined) entry.amount = toD128(amount);
          // A manual line becomes a withdrawal (or back) when its type changes.
          const wasWithdraw = entry.source === EntrySource.WITHDRAW;
          entry.source = isWithdraw(entry.type) ? EntrySource.WITHDRAW : EntrySource.MANUAL;
          await this.ledger.rewrite(entry, session);
          if (wasWithdraw || entry.source === EntrySource.WITHDRAW) {
            await this.audit.record(AuditAction.WITHDRAW, null, userObjectId(user), { entryId: String(entry._id), action: 'UPDATE', changes: dto, amount: entry.amount, mode: entry.mode }, session, entry.businessDate);
          }

          afterCommit(() => {
            this.events.toHotel('entry.updated', { id: String(entry._id), businessDate: entry.businessDate });
            if (entry.stayId) this.events.toHotelAndStay('folio.updated', entry.stayId, { stayId: String(entry.stayId) });
          });
          return entry;
        }),
      id,
    );
  }

  async remove(id: Types.ObjectId, user: Principal) {
    const current = await this.entries.findById(id).select('businessDate').lean();
    if (!current) throw notFound('Entry');
    await this.daybook.assertOpenDayFor(user, current.businessDate);
    return this.tx.run(async ({ session, afterCommit }) => {
      const entry = await this.entries.findById(id).session(session);
      if (!entry) throw notFound('Entry');
      this.assertManual(entry);
      await this.daybook.assertEditable(entry.businessDate, session);
      await this.ledger.softDelete(entry, session);
      if (entry.source === EntrySource.WITHDRAW) {
        await this.audit.record(AuditAction.WITHDRAW, null, userObjectId(user), { entryId: String(entry._id), action: 'DELETE', amount: entry.amount, mode: entry.mode, guestName: entry.guestName }, session, entry.businessDate);
      }
      afterCommit(() => {
        this.events.toHotel('entry.updated', { id: String(entry._id), businessDate: entry.businessDate, deleted: true });
        if (entry.stayId) this.events.toHotelAndStay('folio.updated', entry.stayId, { stayId: String(entry.stayId) });
      });
      return { id: String(entry._id), deleted: true };
    });
  }

  /** Lines posted by check-in, checkout, bills etc. change only through their own module. */
  /**
   * A Withdraw is stored as type "Withdraw", always a DEBIT (400 for CREDIT),
   * BANK unless a mode is given, and never zero. Other entries need mode and dc.
   */
  private normalize(dto: { type?: string; dc?: DebitCredit; mode?: PaymentMode; amount?: string }, current?: { type: string; mode: PaymentMode; dc: DebitCredit }) {
    const type = dto.type ?? current?.type;
    if (isWithdraw(type)) {
      if (dto.type !== undefined) dto.type = WITHDRAW_TYPE;
      if ((dto.dc ?? current?.dc ?? DebitCredit.DEBIT) !== DebitCredit.DEBIT) {
        throw badRequest('WITHDRAW_IS_DEBIT', 'A withdrawal takes money out: it is always a debit');
      }
      if (!current) {
        dto.dc = DebitCredit.DEBIT;
        dto.mode = dto.mode ?? PaymentMode.BANK;
      } else if (!isWithdraw(current.type)) {
        dto.dc = DebitCredit.DEBIT;
      }
      if (dto.amount !== undefined && !dec(dto.amount).gt(0)) throw badRequest('AMOUNT_REQUIRED', 'Enter the amount withdrawn');
      return;
    }
    if (!current) {
      if (!dto.mode) throw badRequest('MODE_REQUIRED', 'Choose the payment mode');
      if (!dto.dc) throw badRequest('DC_REQUIRED', 'Choose credit or debit');
    }
  }

  private assertManual(entry: { source?: EntrySource | null; stayId?: unknown; type?: string }) {
    const source = sourceOf(entry);
    if (source !== EntrySource.MANUAL && source !== EntrySource.WITHDRAW) {
      throw badRequest('ENTRY_NOT_EDITABLE', `This entry comes from ${ORIGIN[source]}; change it there`);
    }
  }

  private async assertRoom(roomId: Types.ObjectId | null) {
    if (roomId && !(await this.rooms.exists({ _id: roomId }))) throw notFound('Room');
  }
}
