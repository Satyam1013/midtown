import { CustomersService, customerPhone } from '../customers/customers.service';
import { Customer } from '../customers/schemas/customer.schema';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { randomInt, timingSafeEqual } from 'crypto';
import { Model } from 'mongoose';
import { Role, staffRole } from '../common/enums';
import { ApiError, badRequest, notFound, unauthorized } from '../common/errors';
import { Principal } from '../common/interfaces/principal';
import { normalizePhone } from '../common/utils/phone';
import { Room } from '../rooms/schemas/room.schema';
import { Stay, StayStatus } from '../stays/schemas/stay.schema';
import { User } from '../users/schemas/user.schema';
import { RequestOtpDto, StaffLoginDto, VerifyOtpDto } from './dto/auth.dto';
import { hashOtp } from './otp-hash';
import { OtpChallenge } from './schemas/otp-challenge.schema';
import { SmsService } from './sms.service';
import { TokenService } from './token.service';

const OTP_RESEND_SECONDS = 30;
const OTP_MAX_ATTEMPTS = 5;
const OTP_WINDOW_MINUTES = 15;
const OTP_MAX_PER_WINDOW = 5;
// Compared against when the identifier is unknown, so response time doesn't reveal it.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Room.name) private readonly rooms: Model<Room>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
    @InjectModel(OtpChallenge.name) private readonly otps: Model<OtpChallenge>,
    private readonly tokens: TokenService,
    private readonly sms: SmsService,
    private readonly config: ConfigService,
    private readonly customers: CustomersService,
    @InjectModel(Customer.name) private readonly customerModel: Model<Customer>,
  ) {
    if (this.otpBypassed) {
      new Logger('OTP').warn('OTP_PROVIDER=bypass: anyone can sign in to the guest app with just a phone number');
    }
  }

  async staffLogin(dto: StaffLoginDto) {
    const id = dto.identifier.trim();
    const filter = id.includes('@') ? { email: id.toLowerCase() } : { phone: id };
    const user = await this.users.findOne(filter).select('+passwordHash +tokenVersion').lean();
    const matches = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !matches || !user.active) throw unauthorized('INVALID_CREDENTIALS', 'Invalid credentials');
    return { ...(await this.issueStaffTokens(user)), user: this.publicUser(user) };
  }

  async refresh(refreshToken: string) {
    const claims = await this.tokens.verifyRefresh(refreshToken);
    const user = await this.users.findById(claims.sub).select('+tokenVersion').lean();
    if (!user || !user.active || (user.tokenVersion ?? 0) !== claims.ver) {
      throw unauthorized('INVALID_REFRESH_TOKEN', 'Session expired, please sign in again');
    }
    return this.issueStaffTokens(user);
  }

  /** Revokes every access and refresh token this user holds. */
  async logout(user: Principal) {
    await this.users.updateOne({ _id: user.userId }, { $inc: { tokenVersion: 1 } });
    return { loggedOut: true };
  }

  async me(user: Principal) {
    if (user.role === Role.GUEST) {
      const c = await this.customerModel.findById(user.customerId).lean();
      return { role: user.role, customer: c && { id: c._id, name: c.name, phone: c.phone } };
    }
    if (user.role === Role.VISITOR) return { role: user.role };
    const staff = await this.users.findById(user.userId).lean();
    return staff ? this.publicUser(staff) : null;
  }

  /** Guest sign-in step 1: an OTP by SMS to the phone. Anyone may sign in, with or without bookings. */
  async requestOtp(dto: RequestOtpDto) {
    const phone = this.loginPhone(dto.phone);
    const minutes = this.config.get<number>('OTP_EXPIRY_MINUTES', 5);
    if (this.otpBypassed) return { sent: true, expiresInMinutes: minutes };
    const login = { phone, purpose: 'GUEST_LOGIN' as const };
    if (await this.otps.exists({ ...login, createdAt: { $gt: new Date(Date.now() - OTP_RESEND_SECONDS * 1000) } })) {
      throw new ApiError(429, 'OTP_TOO_SOON', 'Please wait a moment before asking for another OTP');
    }
    const lately = await this.otps.countDocuments({ ...login, createdAt: { $gt: new Date(Date.now() - OTP_WINDOW_MINUTES * 60_000) } });
    if (lately >= OTP_MAX_PER_WINDOW) {
      throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Too many OTP requests for this number, please try again later');
    }
    const otp = String(randomInt(100000, 1000000));
    await this.otps.updateMany({ ...login, consumedAt: null }, { $set: { consumedAt: new Date() } });
    const challenge = await this.otps.create({ ...login, stayId: null, codeHash: this.hash(otp), expiresAt: new Date(Date.now() + minutes * 60_000) });
    try {
      await this.sms.sendOtp(phone, otp);
    } catch (err) {
      // An OTP that never arrived shouldn't count against the limit.
      await this.otps.deleteOne({ _id: challenge._id });
      throw err;
    }
    return { sent: true, expiresInMinutes: minutes };
  }

  /** Guest sign-in step 2: the token names the customer, created on first sign-in. */
  async verifyOtp(dto: VerifyOtpDto) {
    const phone = this.loginPhone(dto.phone);
    if (!this.otpBypassed) {
      const invalid = unauthorized('INVALID_OTP', 'Wrong or expired OTP');
      const challenge = await this.otps
        .findOne({ phone, purpose: 'GUEST_LOGIN', consumedAt: null, expiresAt: { $gt: new Date() } })
        .select('+codeHash')
        .sort({ createdAt: -1 })
        .lean();
      if (!challenge || challenge.attempts >= OTP_MAX_ATTEMPTS) throw invalid;
      if (!timingSafeEqual(Buffer.from(challenge.codeHash), Buffer.from(this.hash(dto.otp)))) {
        await this.otps.updateOne({ _id: challenge._id }, { $inc: { attempts: 1 } });
        throw invalid;
      }
      // Conditional, so two simultaneous submissions can't both succeed.
      const consumed = await this.otps.updateOne({ _id: challenge._id, consumedAt: null }, { $set: { consumedAt: new Date() } });
      if (!consumed.modifiedCount) throw invalid;
    }
    const customer = (await this.customers.byPhone(phone))!;
    await this.customers.adopt(customer._id, customer.phone);
    return {
      accessToken: await this.tokens.signCustomer(String(customer._id)),
      customer: { id: customer._id, name: customer.name, phone: customer.phone },
    };
  }

  async publicToken() {
    return { accessToken: await this.tokens.signPublic() };
  }

  private get otpBypassed() {
    return this.config.get<string>('OTP_PROVIDER') === 'bypass';
  }

  private loginPhone(raw: string) {
    const phone = customerPhone(raw);
    if (!phone) throw badRequest('INVALID_PHONE', 'Enter a 10-digit phone number');
    return phone;
  }

  private async issueStaffTokens(user: { _id: unknown; role: Role; tokenVersion?: number }) {
    return {
      accessToken: await this.tokens.signAccess(user),
      refreshToken: await this.tokens.signRefresh(user),
    };
  }

  private publicUser(user: any) {
    return { id: String(user._id), name: user.name, phone: user.phone, email: user.email, role: staffRole(user.role) };
  }

  private hash(otp: string) {
    return hashOtp(otp, this.config.getOrThrow<string>('JWT_ACCESS_SECRET'));
  }
}
