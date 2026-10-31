import { Types } from 'mongoose';
import { Role } from '../enums';

export interface Principal {
  role: Role;
  /** Staff tokens only. */
  userId?: string;
  /** GUEST tokens only. The one and only source of a guest's stay. */
  stayId?: string;
}

export interface AccessTokenClaims {
  typ: 'staff' | 'guest' | 'public';
  sub?: string;
  role?: Role;
  ver?: number;
  stayId?: string;
}

export const userObjectId = (p: Principal) => new Types.ObjectId(p.userId);
