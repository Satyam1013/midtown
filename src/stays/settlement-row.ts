import { Types } from 'mongoose';
import { dec, toD128 } from '../common/utils/money';

type SettlementLike = {
  _id: Types.ObjectId;
  stayId: Types.ObjectId;
  customerId?: Types.ObjectId | null;
  businessDate: string;
  time: string;
  guestName: string;
  phone: string;
  vehicle: string | null;
  narration: string;
  billTotal: Types.Decimal128;
  amount: Types.Decimal128;
  payments: { entryId: Types.ObjectId; mode: string; amount: Types.Decimal128 }[];
  creditAmount?: Types.Decimal128 | null;
  shortfall?: Types.Decimal128 | null;
};

/** One check-out as a single register line: the shape the register, entries, customer history and exports share. */
export function settlementRow(s: SettlementLike, roomNumber: string | null) {
  const byMode = new Map<string, ReturnType<typeof dec>>();
  for (const p of s.payments) byMode.set(p.mode, (byMode.get(p.mode) ?? dec(0)).plus(dec(p.amount)));
  const modes = [...byMode.keys()];
  return {
    id: s._id,
    kind: 'entry' as const,
    source: 'CHECKOUT',
    settlementId: s._id,
    businessDate: s.businessDate,
    time: s.time,
    roomNumber,
    guestName: s.guestName,
    phone: s.phone,
    vehicle: s.vehicle,
    stayId: s.stayId,
    customerId: s.customerId ?? null,
    type: 'Check-out',
    mode: modes.length > 1 ? 'MIXED' : (modes[0] ?? null),
    dc: 'CREDIT',
    amount: s.amount,
    billTotal: s.billTotal,
    creditAmount: s.creditAmount ?? null,
    shortfall: s.shortfall && dec(s.shortfall).gt(0) ? s.shortfall : null,
    narration: s.narration,
    payments: [...byMode.entries()].map(([mode, amount]) => ({ mode, amount: toD128(amount) })),
    informational: false,
  };
}
