import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../common/enums';
import { unauthorized } from '../common/errors';
import { AccessTokenClaims, Principal } from '../common/interfaces/principal';
import { Stay, StayStatus } from '../stays/schemas/stay.schema';
import { User } from '../users/schemas/user.schema';

const GUEST_TOKEN_TTL = '30d'; // the guest app has no refresh; check-out ends it sooner
const PUBLIC_TOKEN_TTL = '12h';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Stay.name) private readonly stays: Model<Stay>,
  ) {}

  signAccess(user: { _id: unknown; role: Role; tokenVersion?: number }) {
    return this.jwt.signAsync(
      { typ: 'staff', sub: String(user._id), role: user.role, ver: user.tokenVersion ?? 0 } satisfies AccessTokenClaims,
      { secret: this.accessSecret, expiresIn: this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '12h') as any },
    );
  }

  signRefresh(user: { _id: unknown; tokenVersion?: number }) {
    return this.jwt.signAsync(
      { typ: 'refresh', sub: String(user._id), ver: user.tokenVersion ?? 0 },
      { secret: this.refreshSecret, expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '30d') as any },
    );
  }

  signGuest(stayId: string) {
    return this.jwt.signAsync({ typ: 'guest', stayId } satisfies AccessTokenClaims, {
      secret: this.accessSecret,
      expiresIn: GUEST_TOKEN_TTL,
    });
  }

  signPublic() {
    return this.jwt.signAsync({ typ: 'public' } satisfies AccessTokenClaims, {
      secret: this.accessSecret,
      expiresIn: PUBLIC_TOKEN_TTL,
    });
  }

  async verifyRefresh(token: string): Promise<{ sub: string; ver: number }> {
    try {
      const claims = await this.jwt.verifyAsync(token, { secret: this.refreshSecret });
      if (claims.typ !== 'refresh') throw new Error('wrong token type');
      return claims;
    } catch {
      throw unauthorized('INVALID_REFRESH_TOKEN', 'Session expired, please sign in again');
    }
  }

  /**
   * Token → principal, shared by HTTP and sockets. Checks live state on every
   * call: a deactivated user, a revoked session or a checked-out stay is dead
   * immediately, whatever the token's expiry says.
   */
  async principalFrom(token: string): Promise<Principal> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync(token, { secret: this.accessSecret });
    } catch {
      throw unauthorized('INVALID_TOKEN', 'Invalid or expired token');
    }

    if (claims.typ === 'staff') {
      const user = await this.users.findById(claims.sub).select('+tokenVersion role active').lean();
      if (!user || !user.active || (user.tokenVersion ?? 0) !== claims.ver) {
        throw unauthorized('INVALID_TOKEN', 'Session is no longer valid');
      }
      return { role: user.role, userId: String(user._id) };
    }
    if (claims.typ === 'guest' && claims.stayId) {
      const live = await this.stays.exists({ _id: claims.stayId, status: StayStatus.IN_HOUSE });
      if (!live) throw unauthorized('STAY_ENDED', 'This stay has ended');
      return { role: Role.GUEST, stayId: claims.stayId };
    }
    if (claims.typ === 'public') return { role: Role.VISITOR };
    throw unauthorized('INVALID_TOKEN', 'Invalid or expired token');
  }

  private get accessSecret() {
    return this.config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  private get refreshSecret() {
    return this.config.getOrThrow<string>('JWT_REFRESH_SECRET');
  }
}
