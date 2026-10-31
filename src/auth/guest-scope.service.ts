import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../common/enums';
import { forbidden, unauthorized } from '../common/errors';
import { Principal } from '../common/interfaces/principal';
import { Stay, StayStatus } from '../stays/schemas/stay.schema';

// The single place a guest's stay is resolved. It takes only the verified
// principal, so no request parameter can influence which stay comes back.
@Injectable()
export class GuestScopeService {
  constructor(@InjectModel(Stay.name) private readonly stays: Model<Stay>) {}

  async stayOf(user: Principal) {
    if (user?.role !== Role.GUEST || !user.stayId) {
      throw forbidden('STAY_TOKEN_REQUIRED', 'Sign in with your room number to do this');
    }
    const stay = await this.stays.findOne({ _id: user.stayId, status: StayStatus.IN_HOUSE }).lean();
    if (!stay) throw unauthorized('STAY_ENDED', 'This stay has ended');
    return stay;
  }
}
