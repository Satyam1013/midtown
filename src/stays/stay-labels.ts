import { Model, Types } from 'mongoose';
import { Stay } from './schemas/stay.schema';

/** Adds roomNumber and guestName to rows that hold a stayId, for staff lists. */
export async function withStayLabels<T extends { stayId?: Types.ObjectId | null }>(stays: Model<Stay>, rows: T[]) {
  const found = await stays
    .find({ _id: { $in: rows.map((r) => r.stayId).filter(Boolean) } })
    .select('roomId guestName')
    .populate({ path: 'roomId', select: 'number' })
    .lean();
  const byId = new Map(found.map((s) => [String(s._id), s as any]));
  return rows.map((row) => {
    const stay = row.stayId ? byId.get(String(row.stayId)) : null;
    return { ...row, roomNumber: stay?.roomId?.number ?? null, guestName: stay?.guestName ?? null };
  });
}
