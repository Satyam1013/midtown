import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Booking } from '../bookings/schemas/booking.schema';
import { Role } from '../common/enums';
import { badRequest, forbidden, notFound, unauthorized } from '../common/errors';
import { Principal } from '../common/interfaces/principal';
import { Customer } from '../customers/schemas/customer.schema';
import { Stay, StayStatus } from '../stays/schemas/stay.schema';

// The single place a guest's data is scoped. Everything starts from the
// customer in the verified token; ids sent by the app are only accepted after
// checking they belong to that customer.
@Injectable()
export class GuestScopeService {
  constructor(
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(Booking.name) private readonly bookings: Model<Booking>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
  ) {}

  customerId(user: Principal): Types.ObjectId {
    if (user?.role !== Role.GUEST || !user.customerId) {
      throw forbidden('CUSTOMER_TOKEN_REQUIRED', 'Sign in with your phone number to do this');
    }
    return new Types.ObjectId(user.customerId);
  }

  async customer(user: Principal) {
    const c = await this.customers.findById(this.customerId(user)).lean();
    if (!c) throw unauthorized('INVALID_TOKEN', 'Please sign in again');
    return c;
  }

  /** Stays the customer can see: theirs as main guest, or rooms of their bookings. */
  async ownedStayFilter(customerId: Types.ObjectId) {
    const bookingIds = (await this.bookings.find({ customerId }).select('_id').lean()).map((b) => b._id);
    return { $or: [{ customerId }, { bookingId: { $in: bookingIds } }] };
  }

  async activeStays(customerId: Types.ObjectId) {
    return this.stays.find({ ...(await this.ownedStayFilter(customerId)), status: StayStatus.IN_HOUSE }).lean();
  }

  /** Every id must be the customer's own room, checked in now; otherwise a 400 naming the problem. */
  async requireActiveStays(customerId: Types.ObjectId, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) throw badRequest('STAY_REQUIRED', 'Choose at least one room');
    if (unique.some((id) => !Types.ObjectId.isValid(id))) throw badRequest('INVALID_STAY', 'One of the rooms is not valid');
    const found = await this.stays.find({ _id: { $in: unique }, ...(await this.ownedStayFilter(customerId)) }).lean();
    if (found.length !== unique.length) throw badRequest('INVALID_STAY', 'One of the rooms is not part of your bookings');
    const inactive = found.filter((s) => s.status !== StayStatus.IN_HOUSE);
    if (inactive.length) throw badRequest('STAY_NOT_ACTIVE', 'You can only do this for rooms you are checked in to now');
    return found;
  }

  /** The customer's booking, or 404 (also for another customer's booking, so ids can't be probed). */
  async requireBooking(customerId: Types.ObjectId, bookingId: string) {
    const booking = Types.ObjectId.isValid(bookingId) ? await this.bookings.findOne({ _id: bookingId, customerId }).lean() : null;
    if (!booking) throw notFound('Booking');
    return booking;
  }
}
