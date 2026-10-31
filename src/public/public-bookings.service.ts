import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomInt, timingSafeEqual } from 'crypto';
import { ClientSession, Model } from 'mongoose';
import { hashOtp } from '../auth/otp-hash';
import { OtpChallenge } from '../auth/schemas/otp-challenge.schema';
import { SmsService } from '../auth/sms.service';
import { BookingsService } from '../bookings/bookings.service';
import { Booking, BookingSource } from '../bookings/schemas/booking.schema';
import { ApiError, badRequest, notFound } from '../common/errors';
import { BusinessDateService } from '../common/services/business-date.service';
import { normalizePhone } from '../common/utils/phone';
import { RoomType } from '../room-types/schemas/room-type.schema';
import { PublicBookingDto } from './dto/public-booking.dto';

const WINDOW_MS = 10 * 60_000;
const MAX_OTPS_PER_WINDOW = 3;
const MAX_BOOKINGS_PER_WINDOW = 3;
const MAX_OTP_ATTEMPTS = 5;
const MAX_ROOMS = 10;
const MAX_NIGHTS = 30;

const tooMany = (message: string) => new ApiError(429, 'TOO_MANY_REQUESTS', message);

// Bookings from people with no stay and no login. The phone is proven by OTP,
// and every limit is checked here because the form can't be trusted.
@Injectable()
export class PublicBookingsService {
  constructor(
    @InjectModel(OtpChallenge.name) private readonly otps: Model<OtpChallenge>,
    @InjectModel(Booking.name) private readonly bookings: Model<Booking>,
    @InjectModel(RoomType.name) private readonly types: Model<RoomType>,
    private readonly bookingsService: BookingsService,
    private readonly sms: SmsService,
    private readonly dates: BusinessDateService,
    private readonly config: ConfigService,
  ) {}

  async requestOtp(rawPhone: string) {
    const phone = normalizePhone(rawPhone);
    const minutes = this.config.get<number>('OTP_EXPIRY_MINUTES', 5);
    if (this.otpBypassed) return { sent: true, expiresInMinutes: minutes };

    const recent = await this.otps.countDocuments({ phone, createdAt: { $gt: this.windowStart() } });
    if (recent >= MAX_OTPS_PER_WINDOW) throw tooMany('Too many OTP requests for this number, please try again later');

    const otp = String(randomInt(100000, 1000000));
    await this.otps.updateMany({ phone, consumedAt: null }, { $set: { consumedAt: new Date() } });
    const challenge = await this.otps.create({
      phone,
      codeHash: this.hash(otp),
      expiresAt: new Date(Date.now() + minutes * 60_000),
    });
    try {
      await this.sms.sendOtp(phone, otp);
    } catch (err) {
      // An SMS that never went out shouldn't count against the guest's limit.
      await this.otps.updateOne({ _id: challenge._id }, { $set: { deletedAt: new Date() } });
      throw err;
    }
    return { sent: true, expiresInMinutes: minutes };
  }

  async book(dto: PublicBookingDto) {
    const phone = normalizePhone(dto.phone);
    // Form checks come first, so a typo doesn't use up an OTP attempt.
    await this.assertValid(dto);
    const recent = await this.bookings.countDocuments({
      phone,
      source: BookingSource.GuestApp,
      createdAt: { $gt: this.windowStart() },
    });
    if (recent >= MAX_BOOKINGS_PER_WINDOW) throw tooMany('Too many booking requests for this number, please try again later');

    const challengeId = this.otpBypassed ? null : await this.checkOtp(phone, dto.otp);
    const { otp: _otp, ...fields } = dto;
    const { booking } = await this.bookingsService.createFromGuest(
      { ...fields, guestName: dto.guestName.trim(), phone },
      // In the booking's transaction: if the booking fails the OTP stays usable,
      // and if the OTP was already used no booking is created.
      challengeId ? (session) => this.consume(challengeId, session) : undefined,
    );
    return { booking: { id: booking._id, ref: booking.ref, amount: booking.amount, status: booking.status } };
  }

  private async assertValid(dto: PublicBookingDto) {
    if (dto.rooms > MAX_ROOMS) throw badRequest('BULK_BOOKING', 'For bulk booking, please contact the front desk.');
    if (!this.dates.isRealDate(dto.arrivalDate) || !this.dates.isRealDate(dto.departureDate)) {
      throw badRequest('INVALID_DATES', 'Please choose valid dates');
    }
    if (dto.arrivalDate < this.dates.today()) throw badRequest('INVALID_DATES', 'Arrival cannot be in the past');
    const nights = this.dates.daysBetween(dto.arrivalDate, dto.departureDate);
    if (nights < 1 || nights > MAX_NIGHTS) {
      throw badRequest('INVALID_DATES', `A stay must be between 1 and ${MAX_NIGHTS} nights`);
    }
    const type = await this.types.findById(dto.roomTypeId).select('sleeps').lean();
    if (!type) throw notFound('Room type');
    if (dto.pax > type.sleeps * dto.rooms) {
      throw badRequest('TOO_MANY_GUESTS', `This booking can hold at most ${type.sleeps * dto.rooms} guests`);
    }
  }

  private async checkOtp(phone: string, otp: string) {
    const invalid = badRequest('INVALID_OTP', 'Wrong or expired OTP');
    const challenge = await this.otps
      .findOne({ phone, consumedAt: null, expiresAt: { $gt: new Date() } })
      .select('+codeHash')
      .sort({ createdAt: -1 })
      .lean();
    if (!challenge || challenge.attempts >= MAX_OTP_ATTEMPTS) throw invalid;
    if (!timingSafeEqual(Buffer.from(challenge.codeHash), Buffer.from(this.hash(otp)))) {
      await this.otps.updateOne({ _id: challenge._id }, { $inc: { attempts: 1 } });
      throw invalid;
    }
    return challenge._id;
  }

  private async consume(id: unknown, session: ClientSession) {
    const used = await this.otps.updateOne(
      { _id: id, consumedAt: null },
      { $set: { consumedAt: new Date() } },
      { session },
    );
    if (!used.modifiedCount) throw badRequest('INVALID_OTP', 'Wrong or expired OTP');
  }

  private windowStart() {
    return new Date(Date.now() - WINDOW_MS);
  }

  private get otpBypassed() {
    return this.config.get<string>('OTP_PROVIDER') === 'bypass';
  }

  private hash(otp: string) {
    return hashOtp(otp, this.config.getOrThrow<string>('JWT_ACCESS_SECRET'));
  }
}
