import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { oidOrNull } from '../common/pipes/parse-object-id.pipe';
import { BusinessDateService } from '../common/services/business-date.service';
import { toD128 } from '../common/utils/money';
import { DaybookService } from '../daybook/daybook.service';
import { TransactionService } from '../database/transaction.service';
import { EventsService } from '../notifications/events.service';
import { Room } from '../rooms/schemas/room.schema';
import { CreateEntryDto, UpdateEntryDto } from './dto/entry.dto';
import { LedgerService } from './ledger.service';
import { DayRegisterEntry } from './schemas/day-register-entry.schema';

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

  list(date: string) {
    return this.entries.find({ businessDate: date }).sort({ time: 1, createdAt: 1 }).lean();
  }

  async create(dto: CreateEntryDto, user: Principal) {
    this.dates.assertAllowed(dto.businessDate, user);
    const roomId = oidOrNull(dto.roomId);
    await this.assertRoom(roomId);
    const key = { businessDate: dto.businessDate, roomId, type: dto.type, amount: dto.amount, guestName: dto.guestName };
    return this.ledger.withDuplicateGuard(key, () =>
      this.tx.run(async ({ session, afterCommit }) => {
        await this.daybook.touchOpenDay(dto.businessDate, user, session);
        const existing = await this.ledger.findDuplicate(key, session);
        if (existing) throw this.ledger.duplicateError(existing._id);
        const entry = await this.ledger.post({ ...dto, roomId, createdByUserId: userObjectId(user) }, session);
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
          await this.daybook.touchOpenDay(entry.businessDate, user, session);
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
      await this.daybook.touchOpenDay(entry.businessDate, user, session);
      await this.ledger.softDelete(entry, session);
      afterCommit(() => {
        this.events.toHotel('entry.updated', { id: String(entry._id), businessDate: entry.businessDate, deleted: true });
        if (entry.stayId) this.events.toHotelAndStay('folio.updated', entry.stayId, { stayId: String(entry.stayId) });
      });
      return { id: String(entry._id), deleted: true };
    });
  }

  private async assertRoom(roomId: Types.ObjectId | null) {
    if (roomId && !(await this.rooms.exists({ _id: roomId }))) throw notFound('Room');
  }
}
