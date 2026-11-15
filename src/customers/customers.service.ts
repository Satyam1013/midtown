import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { Paged } from '../common/interceptors/response.interceptor';
import { badRequest, conflict, notFound } from '../common/errors';
import { Principal, userObjectId } from '../common/interfaces/principal';
import { dec, toD128 } from '../common/utils/money';
import { normalizePhone } from '../common/utils/phone';
import { TransactionService } from '../database/transaction.service';
import { DayRegisterEntry } from '../entries/schemas/day-register-entry.schema';
import { FolioLine } from '../folio/schemas/folio-line.schema';
import { RoomType } from '../room-types/schemas/room-type.schema';
import { Room } from '../rooms/schemas/room.schema';
import { StayGuest } from '../stays/schemas/stay-guest.schema';
import { Stay } from '../stays/schemas/stay.schema';
import { CustomerDocumentsService } from './customer-documents.service';
import { CustomerListQueryDto, UpdateCustomerDto } from './dto/customer.dto';
import { CustomerDocument } from './schemas/customer-document.schema';
import { Customer } from './schemas/customer.schema';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A phone counts only with 10 digits; anything shorter is treated as no phone. */
export const customerPhone = (raw?: string | null) => {
  const p = normalizePhone(raw);
  return p.length === 10 ? p : null;
};

@Injectable()
export class CustomersService {
  constructor(
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(CustomerDocument.name) private readonly documents: Model<CustomerDocument>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    @InjectModel(StayGuest.name) private readonly stayGuests: Model<StayGuest>,
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(RoomType.name) private readonly roomTypes: Model<RoomType>,
    @InjectModel(FolioLine.name) private readonly folio: Model<FolioLine>,
    @InjectModel(DayRegisterEntry.name) private readonly entries: Model<DayRegisterEntry>,
    private readonly docs: CustomerDocumentsService,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The customer for a new stay or added guest, counting one visit:
   * the given id, else the one with this phone, else a new one.
   * The upsert on the unique phone index means one customer per phone, even
   * with two check-ins at once.
   */
  async forVisit(input: { customerId?: string | null; name?: string; phone?: string | null }, session: ClientSession) {
    const now = new Date();
    const name = (input.name ?? '').trim();
    const visit = { $inc: { visits: 1 }, $set: { lastVisitAt: now } };
    let customer;
    if (input.customerId) {
      customer = await this.customers.findOneAndUpdate({ _id: input.customerId }, visit, { new: true, session });
      if (!customer) throw notFound('Customer');
    } else {
      const phone = customerPhone(input.phone);
      if (phone) {
        customer = await this.customers.findOneAndUpdate(
          { phone },
          { ...visit, $setOnInsert: { phone, name, firstVisitAt: now } },
          { new: true, upsert: true, session, setDefaultsOnInsert: true },
        );
      } else {
        [customer] = await this.customers.create([{ name, phone: null, firstVisitAt: now, lastVisitAt: now, visits: 1 }], { session });
      }
    }
    if (!customer.name && name) {
      customer.name = name;
      await customer.save({ session });
    }
    return customer;
  }

  /** Adds a checked-out stay's charges to its customer's total. */
  async addSpent(customerId: Types.ObjectId | null | undefined, amount: string, session: ClientSession) {
    if (!customerId || dec(amount).isZero()) return;
    await this.customers.updateOne({ _id: customerId }, { $inc: { totalSpent: toD128(amount) } }, { session });
  }

  async lookup(rawPhone: string) {
    const phone = customerPhone(rawPhone);
    if (!phone) throw badRequest('INVALID_PHONE', 'Enter a 10-digit phone number');
    const c = await this.customers.findOne({ phone }).lean();
    return {
      customer: c
        ? { id: c._id, name: c.name, phone: c.phone, visits: c.visits, hasDocument: c.documentCount > 0, documentType: c.documentType }
        : null,
    };
  }

  async list(q: CustomerListQueryDto) {
    const limit = q.limit ?? 50;
    const filter: Record<string, unknown> = {};
    const and: Record<string, unknown>[] = [];
    if (q.filter === 'repeat') filter.visits = { $gt: 1 };
    if (q.filter === 'nodoc') filter.documentCount = 0;
    const search = q.search?.trim();
    if (search) {
      const digits = search.replace(/\D/g, '');
      and.push({
        $or: [
          { name: { $regex: escapeRegex(search), $options: 'i' } },
          ...(digits.length >= 3 ? [{ phone: { $regex: escapeRegex(digits) } }] : []),
        ],
      });
    }
    if (q.cursor) {
      const { t, id } = this.decodeCursor(q.cursor);
      and.push({ $or: [{ lastVisitAt: { $lt: t } }, { lastVisitAt: t, _id: { $lt: id } }] });
    }
    if (and.length) filter.$and = and;
    const rows = await this.customers.find(filter).sort({ lastVisitAt: -1, _id: -1 }).limit(limit + 1).lean();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? this.encodeCursor(last.lastVisitAt!, last._id) : null;
    return new Paged(
      page.map((c) => ({
        id: c._id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        visits: c.visits,
        totalSpent: c.totalSpent,
        lastVisitAt: c.lastVisitAt,
        hasDocument: c.documentCount > 0,
        documentType: c.documentType,
      })),
      { limit, nextCursor },
    );
  }

  async detail(id: Types.ObjectId, user: Principal) {
    const c = await this.customers.findById(id).lean();
    if (!c) throw notFound('Customer');
    const [main, added] = await Promise.all([
      this.stays.find({ customerId: id }).sort({ checkIn: -1 }).lean(),
      this.stayGuests.find({ customerId: id }).select('stayId').lean(),
    ]);
    const addedIds = added.map((g) => String(g.stayId)).filter((s) => !main.some((m) => String(m._id) === s));
    const extra = addedIds.length ? await this.stays.find({ _id: { $in: addedIds } }).lean() : [];
    const stays = [...main, ...extra].sort((a, b) => b.checkIn.localeCompare(a.checkIn));
    const stayIds = stays.map((s) => s._id);

    const [rooms, money, payments, documents] = await Promise.all([
      this.rooms.find({ _id: { $in: stays.map((s) => s.roomId) } }).select('number roomTypeId').lean(),
      this.folio.aggregate<{ _id: { stayId: Types.ObjectId; paid: boolean }; total: Types.Decimal128 }>([
        { $match: { stayId: { $in: stayIds }, deletedAt: null } },
        { $group: { _id: { stayId: '$stayId', paid: { $in: ['$source', ['PAYMENT', 'REFUND']] } }, total: { $sum: '$amount' } } },
      ]),
      this.entries.find({ stayId: { $in: stayIds } }).sort({ businessDate: -1, time: -1 }).lean(),
      this.docs.list(id, user),
    ]);
    const types = await this.roomTypes.find({ _id: { $in: rooms.map((r) => r.roomTypeId) } }).select('name').lean();
    const roomOf = new Map(rooms.map((r) => [String(r._id), r]));
    const typeOf = new Map(types.map((t) => [String(t._id), t.name]));
    const sumOf = (stayId: Types.ObjectId, paid: boolean) =>
      dec(money.find((m) => String(m._id.stayId) === String(stayId) && m._id.paid === paid)?.total);

    return {
      id: c._id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      notes: c.notes,
      visits: c.visits,
      totalSpent: c.totalSpent,
      firstVisitAt: c.firstVisitAt,
      lastVisitAt: c.lastVisitAt,
      createdAt: (c as any).createdAt,
      hasDocument: c.documentCount > 0,
      documentType: c.documentType,
      documents,
      stays: stays.map((s) => {
        const room = roomOf.get(String(s.roomId));
        const total = sumOf(s._id, false);
        // Payment lines are negative and refunds positive on the folio.
        const paid = sumOf(s._id, true).negated();
        return {
          id: s._id,
          role: String(s.customerId) === String(id) ? 'MAIN' : 'ADDED',
          roomNumber: room?.number ?? null,
          roomType: room ? (typeOf.get(String(room.roomTypeId)) ?? null) : null,
          checkInDate: s.checkIn,
          checkOutDate: s.checkOut,
          nights: s.nights,
          guests: s.guests ?? 1,
          total: toD128(total),
          paid: toD128(paid),
          balance: toD128(total.minus(paid)),
          status: s.status,
        };
      }),
      payments: payments.map((e) => ({
        id: e._id,
        stayId: e.stayId,
        businessDate: e.businessDate,
        type: e.type,
        mode: e.mode,
        dc: e.dc,
        amount: e.amount,
        narration: e.narration,
      })),
    };
  }

  async update(id: Types.ObjectId, dto: UpdateCustomerDto, user: Principal) {
    try {
      return await this.tx.run(async ({ session }) => {
        const c = await this.customers.findById(id).session(session);
        if (!c) throw notFound('Customer');
        const before = { name: c.name, phone: c.phone, email: c.email };
        if (dto.phone !== undefined) {
          const phone = dto.phone === null || dto.phone === '' ? null : customerPhone(dto.phone);
          if (dto.phone && !phone) throw badRequest('INVALID_PHONE', 'Enter a 10-digit phone number');
          if (phone && phone !== c.phone) {
            const other = await this.customers.findOne({ phone, _id: { $ne: id } }).session(session).lean();
            if (other) throw this.phoneTaken(other._id);
          }
          c.phone = phone;
        }
        if (dto.name !== undefined) c.name = dto.name.trim();
        if (dto.email !== undefined) c.email = dto.email || null;
        if (dto.notes !== undefined) c.notes = dto.notes;
        await c.save({ session });
        await this.audit.record(AuditAction.CUSTOMER_UPDATE, null, userObjectId(user), { customerId: id, before, after: { name: c.name, phone: c.phone, email: c.email } }, session);
        return c;
      });
    } catch (err: any) {
      if (err?.code === 11000 && String(err.message).includes('one_customer_per_phone')) {
        const other = await this.customers.findOne({ phone: customerPhone(dto.phone) }).lean();
        throw this.phoneTaken(other?._id);
      }
      throw err;
    }
  }

  /** Moves everything of `id` onto `intoId` and removes `id`. */
  merge(id: Types.ObjectId, intoId: string, user: Principal) {
    if (String(id) === intoId) throw badRequest('SAME_CUSTOMER', 'Choose a different customer to merge into');
    return this.tx.run(async ({ session }) => {
      const [from, into] = await Promise.all([
        this.customers.findById(id).session(session),
        this.customers.findById(intoId).session(session),
      ]);
      if (!from || !into) throw notFound('Customer');
      await Promise.all([
        this.stays.updateMany({ customerId: from._id }, { $set: { customerId: into._id } }, { session }),
        this.stayGuests.updateMany({ customerId: from._id }, { $set: { customerId: into._id } }, { session }),
        this.documents.updateMany({ customerId: from._id }, { $set: { customerId: into._id } }, { session }),
      ]);
      const earliest = [from.firstVisitAt, into.firstVisitAt].filter(Boolean).sort((a, b) => +a! - +b!)[0] ?? null;
      const latest = [from.lastVisitAt, into.lastVisitAt].filter(Boolean).sort((a, b) => +b! - +a!)[0] ?? null;
      const snapshot = { id: from._id, name: from.name, phone: from.phone, email: from.email, visits: from.visits, totalSpent: from.totalSpent };
      // Soft-delete first: it frees the phone before `into` may take it.
      await this.customers.updateOne({ _id: from._id }, { $set: { deletedAt: new Date() } }, { session });
      Object.assign(into, {
        name: into.name || from.name,
        phone: into.phone ?? from.phone,
        email: into.email ?? from.email,
        notes: [into.notes, from.notes].filter(Boolean).join('\n'),
        visits: into.visits + from.visits,
        totalSpent: toD128(dec(into.totalSpent).plus(dec(from.totalSpent))),
        firstVisitAt: earliest,
        lastVisitAt: latest,
        documentCount: into.documentCount + from.documentCount,
        documentType: into.documentType ?? from.documentType,
      });
      await into.save({ session });
      await this.audit.record(AuditAction.CUSTOMER_MERGE, null, userObjectId(user), { from: snapshot, into: into._id }, session);
      return into;
    });
  }

  private phoneTaken(existingCustomerId: unknown) {
    return conflict('CUSTOMER_PHONE_EXISTS', 'Another customer has this phone number; merge them instead', {
      existingCustomerId: existingCustomerId ? String(existingCustomerId) : null,
    });
  }

  private encodeCursor(t: Date, id: Types.ObjectId) {
    return Buffer.from(JSON.stringify({ t: t.toISOString(), id: String(id) })).toString('base64url');
  }

  private decodeCursor(cursor: string) {
    try {
      const { t, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      const date = new Date(t);
      if (Number.isNaN(+date) || !Types.ObjectId.isValid(id)) throw new Error();
      return { t: date, id: new Types.ObjectId(id) };
    } catch {
      throw badRequest('INVALID_CURSOR', 'The cursor is not valid');
    }
  }
}
