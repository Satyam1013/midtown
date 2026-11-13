import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { CashTxn } from '../cash-transactions/schemas/cash-txn.schema';
import { DebitCredit, PaymentMode } from '../common/enums';
import { conflict } from '../common/errors';
import { dec, toD128 } from '../common/utils/money';
import { FolioLine, FolioSource } from '../folio/schemas/folio-line.schema';
import { DayRegisterEntry, DayRegisterEntryDocument, EntrySource } from './schemas/day-register-entry.schema';

export interface PostInput {
  businessDate: string;
  time: string;
  roomId?: Types.ObjectId | null;
  stayId?: Types.ObjectId | null;
  guestName?: string;
  phone?: string | null;
  vehicle?: string | null;
  type: string;
  mode: PaymentMode;
  dc: DebitCredit;
  amount: string;
  narration?: string;
  createdByUserId: Types.ObjectId;
  source: EntrySource;
  /** Checkout only: balance left unpaid. */
  shortfall?: string | null;
  /** When set, the entry also posts one folio line to stayId. */
  folio?: { head: string; source: FolioSource };
}

export interface DuplicateKey {
  businessDate: string;
  roomId?: Types.ObjectId | null;
  type: string;
  amount: string;
  guestName?: string;
}

const COLLATION = { locale: 'en', strength: 2 };

/** Cash coming in reduces what the guest owes; a refund increases it. */
const folioAmount = (dc: DebitCredit, amount: string) =>
  toD128(dc === DebitCredit.CREDIT ? dec(amount).negated() : dec(amount));

// The one place an entry, its cash line and its folio line are written.
// Every method requires the caller's transaction session.
@Injectable()
export class LedgerService {
  constructor(
    @InjectModel(DayRegisterEntry.name) private readonly entries: Model<DayRegisterEntry>,
    @InjectModel(CashTxn.name) private readonly cash: Model<CashTxn>,
    @InjectModel(FolioLine.name) private readonly folio: Model<FolioLine>,
  ) {}

  async post(input: PostInput, session: ClientSession): Promise<DayRegisterEntryDocument> {
    const { folio, amount, shortfall, ...fields } = input;
    const [entry] = await this.entries.create(
      [
        {
          ...fields,
          guestName: (input.guestName ?? '').trim(),
          amount: toD128(amount),
          shortfall: shortfall ? toD128(shortfall) : null,
        },
      ],
      { session },
    );
    if (dec(amount).gt(0)) {
      entry.txnId = await this.createCash(entry, session);
      await entry.save({ session });
    }
    if (folio && input.stayId) {
      await this.folio.create(
        [{ stayId: input.stayId, head: folio.head, amount: folioAmount(input.dc, amount), source: folio.source, entryId: entry._id }],
        { session },
      );
    }
    return entry;
  }

  /** Applies edits to the entry and rewrites its one CashTxn and folio line to match. */
  async rewrite(entry: DayRegisterEntryDocument, session: ClientSession): Promise<void> {
    const positive = dec(entry.amount).gt(0);
    const existing = await this.cash.findOne({ entryId: entry._id }).session(session);
    if (positive && existing) {
      existing.head = entry.type;
      existing.mode = entry.mode;
      existing.dc = entry.dc;
      existing.amount = entry.amount;
      existing.narration = this.narrationOf(entry);
      await existing.save({ session });
    } else if (positive) {
      entry.txnId = await this.createCash(entry, session);
    } else if (existing) {
      await this.cash.updateOne({ _id: existing._id }, { $set: { deletedAt: new Date() } }, { session });
      entry.txnId = null;
    }
    await entry.save({ session });

    const line = await this.folio.findOne({ entryId: entry._id }).session(session);
    if (line) {
      if (positive) {
        line.amount = folioAmount(entry.dc, entry.amount.toString());
        await line.save({ session });
      } else {
        await this.folio.updateOne({ _id: line._id }, { $set: { deletedAt: new Date() } }, { session });
      }
    }
  }

  async softDelete(entry: DayRegisterEntryDocument, session: ClientSession): Promise<void> {
    const now = new Date();
    await this.cash.updateOne({ entryId: entry._id }, { $set: { deletedAt: now } }, { session });
    await this.folio.updateOne({ entryId: entry._id }, { $set: { deletedAt: now } }, { session });
    await this.entries.updateOne({ _id: entry._id }, { $set: { deletedAt: now } }, { session });
  }

  /** Rule 1. Skipped for zero amounts and for lines with neither a room nor a name. */
  async findDuplicate(key: DuplicateKey, session: ClientSession | null, excludeId?: Types.ObjectId) {
    const guestName = (key.guestName ?? '').trim();
    if (!dec(key.amount).gt(0) || (!key.roomId && !guestName)) return null;
    return this.entries
      .findOne({
        businessDate: key.businessDate,
        roomId: key.roomId ?? null,
        type: key.type,
        amount: toD128(key.amount),
        guestName,
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      })
      .collation(COLLATION)
      .session(session)
      .lean();
  }

  duplicateError(entryId: unknown) {
    return conflict('DUPLICATE_ENTRY', 'This entry already exists; edit it instead of adding it again', {
      entryId: String(entryId),
    });
  }

  /**
   * Turns the unique index firing into the same 409 the pre-check gives. It
   * fires when two desks submit the same entry at the same moment.
   */
  async withDuplicateGuard<T>(key: DuplicateKey, work: () => Promise<T>, excludeId?: Types.ObjectId): Promise<T> {
    try {
      return await work();
    } catch (err: any) {
      if (err?.code === 11000 && String(err.message).includes('no_duplicate_entry')) {
        const existing = await this.findDuplicate(key, null, excludeId);
        throw this.duplicateError(existing?._id);
      }
      throw err;
    }
  }

  private async createCash(entry: DayRegisterEntryDocument, session: ClientSession) {
    const [txn] = await this.cash.create(
      [
        {
          businessDate: entry.businessDate,
          head: entry.type,
          mode: entry.mode,
          dc: entry.dc,
          amount: entry.amount,
          narration: this.narrationOf(entry),
          entryId: entry._id,
        },
      ],
      { session },
    );
    return txn._id;
  }

  private narrationOf(entry: DayRegisterEntryDocument) {
    return entry.narration || entry.guestName || '';
  }
}
