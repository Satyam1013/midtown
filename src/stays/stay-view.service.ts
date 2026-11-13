import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { dec, toD128 } from '../common/utils/money';
import { FolioLine, FolioSource } from '../folio/schemas/folio-line.schema';
import { Room } from '../rooms/schemas/room.schema';
import { RoomShift } from './schemas/room-shift.schema';

/**
 * The stay as the apps read it: roomCharges[] with amounts and shifts[] with
 * room numbers. Stays from before segments get one segment derived from the
 * stay itself, so old and new stays look the same.
 */
@Injectable()
export class StayViewService {
  constructor(
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(RoomShift.name) private readonly shifts: Model<RoomShift>,
    @InjectModel(FolioLine.name) private readonly folio: Model<FolioLine>,
  ) {}

  async decorate<T extends Record<string, any>>(stays: T[]) {
    if (!stays.length) return [];
    const ids = stays.map((s) => s._id as Types.ObjectId);
    const [shifts, tariffLines] = await Promise.all([
      this.shifts.find({ stayId: { $in: ids } }).sort({ createdAt: 1 }).lean(),
      this.folio.find({ stayId: { $in: ids }, source: FolioSource.TARIFF }).lean(),
    ]);
    const roomIds = new Set<string>();
    stays.forEach((s) => roomIds.add(String(s.roomId)));
    shifts.forEach((s) => [s.fromRoomId, s.toRoomId].forEach((r) => roomIds.add(String(r))));
    const rooms = await this.rooms.find({ _id: { $in: [...roomIds] } }).select('number').lean();
    const numberOf = new Map(rooms.map((r) => [String(r._id), r.number]));
    const lineOf = new Map(tariffLines.map((l) => [String(l._id), l]));

    return stays.map((stay) => {
      const number = numberOf.get(String(stay.roomId)) ?? '';
      const segments = stay.roomCharges?.length
        ? stay.roomCharges
        : [
            {
              label: `Room ${number}`,
              roomId: stay.roomId,
              roomNumber: number,
              guests: stay.guests ?? 1,
              rate: stay.rate,
              nights: stay.nights,
              folioLineId: tariffLines.find((l) => String(l.stayId) === String(stay._id))?._id ?? null,
            },
          ];
      return {
        ...stay,
        guests: stay.guests ?? 1,
        roomCharges: segments.map((seg: any) => ({
          id: seg._id ?? null,
          label: seg.label,
          roomId: seg.roomId,
          roomNumber: seg.roomNumber,
          guests: seg.guests,
          rate: seg.rate,
          nights: seg.nights,
          // rate × nights, before GST.
          amount: toD128(dec(seg.rate).times(seg.nights)),
          // What the folio line charges for this segment: amount + 12% GST.
          billed: seg.folioLineId ? (lineOf.get(String(seg.folioLineId))?.amount ?? null) : null,
        })),
        shifts: shifts
          .filter((s) => String(s.stayId) === String(stay._id))
          .map((s) => ({
            id: s._id,
            fromRoomNumber: numberOf.get(String(s.fromRoomId)) ?? null,
            toRoomNumber: numberOf.get(String(s.toRoomId)) ?? null,
            fromRate: s.fromRate,
            toRate: s.toRate,
            kind: s.kind,
            date: s.businessDate,
            time: s.time,
            nightsBefore: s.nightsBefore,
            adjustment: s.adjustment,
            reason: s.reason,
          })),
      };
    });
  }
}
