import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { Booking, BookingSource, BookingStatus } from '../../bookings/schemas/booking.schema';
import { dec, toD128 } from '../../common/utils/money';
import { normalizePhone } from '../../common/utils/phone';
import { customerPhone } from '../../customers/customers.service';
import { Customer } from '../../customers/schemas/customer.schema';
import { Room } from '../../rooms/schemas/room.schema';
import { Stay, StayStatus } from '../../stays/schemas/stay.schema';
import { CounterService } from '../counter.service';
import { assertTransactionsSupported } from '../database-health.service';
import { TransactionService } from '../transaction.service';
import { SeedModule } from './seed.module';

// One-off, idempotent, for the customer-based guest app. Run after migrate:customers.
//  1. booking phones are stored as 10 digits
//  2. bookings without a customer are linked to the customer with their phone (created if new)
//  3. stays without a booking get a one-room walk-in booking
//  4. bookings whose rooms have all checked out become CHECKED_OUT
const log = new Logger('Migrate');

async function main() {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn', 'log'] });
  try {
    await assertTransactionsSupported(app.get<Connection>(getConnectionToken()));
    const bookings = app.get<Model<Booking>>(getModelToken(Booking.name));
    const customers = app.get<Model<Customer>>(getModelToken(Customer.name));
    const stays = app.get<Model<Stay>>(getModelToken(Stay.name));
    const rooms = app.get<Model<Room>>(getModelToken(Room.name));
    const counters = app.get(CounterService);

    const result = await app.get(TransactionService).run(async ({ session }) => {
      let phonesFixed = 0;
      let bookingsLinked = 0;
      let walkIns = 0;
      for (const b of await bookings.find({}).session(session)) {
        const phone = normalizePhone(b.phone);
        if (phone !== b.phone) {
          b.phone = phone;
          phonesFixed++;
        }
        if (!b.customerId && customerPhone(phone)) {
          const c = await customers.findOneAndUpdate(
            { phone },
            { $setOnInsert: { phone, name: b.guestName, visits: 0, firstVisitAt: null, lastVisitAt: null } },
            { new: true, upsert: true, session, setDefaultsOnInsert: true },
          );
          b.customerId = c!._id;
          bookingsLinked++;
        }
        if (b.isModified()) await b.save({ session });
      }
      for (const s of await stays.find({ $or: [{ bookingId: null }, { bookingId: { $exists: false } }] }).session(session).lean()) {
        const room = await rooms.findById(s.roomId).select('roomTypeId').session(session).lean();
        if (!room) continue;
        const seq = await counters.next('walkin-booking', session);
        const [b] = await bookings.create(
          [
            {
              source: BookingSource.WalkIn,
              ref: `WI${String(seq).padStart(6, '0')}`,
              guestName: s.guestName,
              phone: s.phone ?? '',
              roomTypeId: room.roomTypeId,
              rooms: 1,
              pax: s.guests ?? 1,
              arrivalDate: s.checkIn,
              departureDate: s.checkOut,
              amount: toD128(dec(s.rate).times(s.nights)),
              status: s.status === StayStatus.IN_HOUSE ? BookingStatus.CHECKED_IN : BookingStatus.CHECKED_OUT,
              customerId: s.customerId ?? null,
            },
          ],
          { session },
        );
        await stays.updateOne({ _id: s._id }, { $set: { bookingId: b._id } }, { session });
        walkIns++;
      }
      let checkedOut = 0;
      for (const b of await bookings.find({ status: BookingStatus.CHECKED_IN }).session(session).lean()) {
        if (!(await stays.exists({ bookingId: b._id, status: StayStatus.IN_HOUSE }).session(session))) {
          await bookings.updateOne({ _id: b._id }, { $set: { status: BookingStatus.CHECKED_OUT } }, { session });
          checkedOut++;
        }
      }
      return { phonesFixed, bookingsLinked, walkInBookingsCreated: walkIns, bookingsCheckedOut: checkedOut };
    });
    log.log(`done ${JSON.stringify(result)}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
