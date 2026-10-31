import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { Model } from 'mongoose';
import { Role } from '../common/enums';
import { ApiError, notFound, unauthorized } from '../common/errors';
import { Principal } from '../common/interfaces/principal';
import { normalizePhone } from '../common/utils/phone';
import { Room } from '../rooms/schemas/room.schema';
import { Stay, StayStatus } from '../stays/schemas/stay.schema';
import { User } from '../users/schemas/user.schema';
import { RequestOtpDto, StaffLoginDto, VerifyOtpDto } from './dto/auth.dto';
import { OtpChallenge } from './schemas/otp-challenge.schema';
import { SmsService } from './sms.service';
import { TokenService } from './token.service';

const OTP_RESEND_SECONDS = 30;
const OTP_MAX_ATTEMPTS = 5;
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
  ) {
    if (this.otpBypassed) {
      new Logger('OTP').warn('OTP_PROVIDER=bypass: guest login needs only a room number and phone');
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
      const stay = await this.stays.findById(user.stayId).lean();
      return { role: user.role, stay };
    }
    if (user.role === Role.VISITOR) return { role: user.role };
    const staff = await this.users.findById(user.userId).lean();
    return staff ? this.publicUser(staff) : null;
  }

  async requestOtp(dto: RequestOtpDto) {
    const stay = await this.matchStay(dto);
    if (this.otpBypassed) {
      return { sent: true, expiresInMinutes: this.config.get<number>('OTP_EXPIRY_MINUTES', 5) };
    }
    const recent = await this.otps.exists({
      stayId: stay._id,
      createdAt: { $gt: new Date(Date.now() - OTP_RESEND_SECONDS * 1000) },
    });
    if (recent) throw new ApiError(429, 'OTP_TOO_SOON', 'Please wait a moment before asking for another OTP');

    const otp = String(randomInt(100000, 1000000));
    const minutes = this.config.get<number>('OTP_EXPIRY_MINUTES', 5);
    await this.otps.updateMany({ stayId: stay._id, consumedAt: null }, { $set: { consumedAt: new Date() } });
    await this.otps.create({
      stayId: stay._id,
      codeHash: this.hash(otp),
      expiresAt: new Date(Date.now() + minutes * 60_000),
    });
    await this.sms.sendOtp(stay.phone, otp);
    return { sent: true, expiresInMinutes: minutes };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const stay = await this.matchStay(dto);
    if (this.otpBypassed) return { accessToken: await this.tokens.signGuest(String(stay._id)), stay };
    const invalid = unauthorized('INVALID_OTP', 'Wrong or expired OTP');
    const challenge = await this.otps
      .findOne({ stayId: stay._id, consumedAt: null, expiresAt: { $gt: new Date() } })
      .select('+codeHash')
      .sort({ createdAt: -1 })
      .lean();
    if (!challenge || challenge.attempts >= OTP_MAX_ATTEMPTS) throw invalid;

    const expected = Buffer.from(challenge.codeHash);
    const given = Buffer.from(this.hash(dto.otp));
    if (!timingSafeEqual(expected, given)) {
      await this.otps.updateOne({ _id: challenge._id }, { $inc: { attempts: 1 } });
      throw invalid;
    }
    // Conditional, so two simultaneous submissions can't both succeed.
    const consumed = await this.otps.updateOne(
      { _id: challenge._id, consumedAt: null },
      { $set: { consumedAt: new Date() } },
    );
    if (!consumed.modifiedCount) throw invalid;
    return { accessToken: await this.tokens.signGuest(String(stay._id)), stay };
  }

  async publicToken() {
    return { accessToken: await this.tokens.signPublic() };
  }

  private get otpBypassed() {
    return this.config.get<string>('OTP_PROVIDER') === 'bypass';
  }

  private async matchStay(dto: RequestOtpDto) {
    const phone = normalizePhone(dto.phone);
    const room = await this.rooms.findOne({ number: dto.roomNumber.trim() }).select('_id').lean();
    const stay =
      room && phone
        ? await this.stays.findOne({ roomId: room._id, status: StayStatus.IN_HOUSE, phone }).lean()
        : null;
    if (!stay) throw notFound('A current stay for this room and phone number was');
    return stay;
  }

  private async issueStaffTokens(user: { _id: unknown; role: Role; tokenVersion?: number }) {
    return {
      accessToken: await this.tokens.signAccess(user),
      refreshToken: await this.tokens.signRefresh(user),
    };
  }

  private publicUser(user: any) {
    return { id: String(user._id), name: user.name, phone: user.phone, email: user.email, role: user.role };
  }

  private hash(otp: string) {
    return createHmac('sha256', this.config.getOrThrow<string>('JWT_ACCESS_SECRET')).update(otp).digest('hex');
  }
}
