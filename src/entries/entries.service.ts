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
import { CreateEntryDto, UpdateEntryDto } from './dto/entry.dto';
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
  ) {}

  async list(date: string) {
    const rows = await this.entries.find({ businessDate: date }).sort({ time: 1, createdAt: 1 }).lean();
    return rows.map((e) => ({ ...e, source: sourceOf(e), shortfall: e.shortfall ?? null }));
  }

  /** A manual register line, always on the open business day; any businessDate sent is ignored. */
  async create(dto: CreateEntryDto, user: Principal) {
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
          { ...fields, businessDate: key.businessDate, roomId, source: EntrySource.MANUAL, createdByUserId: userObjectId(user) },
          session,
        );
        afterCommit(() => this.events.toHotel('entry.created', { id: String(entry._id), businessDate: entry.businessDate }));
        return entry;
      }),
    );
  }

  async update(id: Types.ObjectId, dto: UpdateEntryDto, user: Principal) {
    const current = await this.entries.findById(id).lean();
    if (!current) throw notFound('Entry');
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
          await this.ledger.rewrite(entry, session);

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
    return this.tx.run(async ({ session, afterCommit }) => {
      const entry = await this.entries.findById(id).session(session);
      if (!entry) throw notFound('Entry');
      this.assertManual(entry);
      await this.daybook.assertEditable(entry.businessDate, session);
      await this.ledger.softDelete(entry, session);
      afterCommit(() => {
        this.events.toHotel('entry.updated', { id: String(entry._id), businessDate: entry.businessDate, deleted: true });
        if (entry.stayId) this.events.toHotelAndStay('folio.updated', entry.stayId, { stayId: String(entry.stayId) });
      });
      return { id: String(entry._id), deleted: true };
    });
  }

  /** Lines posted by check-in, checkout, bills etc. change only through their own module. */
  private assertManual(entry: { source?: EntrySource | null; stayId?: unknown; type?: string }) {
    const source = sourceOf(entry);
    if (source !== EntrySource.MANUAL) {
      throw badRequest('ENTRY_NOT_EDITABLE', `This entry comes from ${ORIGIN[source]}; change it there`);
    }
  }

  private async assertRoom(roomId: Types.ObjectId | null) {
    if (roomId && !(await this.rooms.exists({ _id: roomId }))) throw notFound('Room');
  }
}
