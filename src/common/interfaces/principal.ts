import { Types } from 'mongoose';
import { Role } from '../enums';

export interface Principal {
  role: Role;
  /** Staff tokens only. */
  userId?: string;
  /** GUEST tokens only: the customer signed in by phone. Every /guest query is scoped by it. */
  customerId?: string;
}

export interface AccessTokenClaims {
  typ: 'staff' | 'guest' | 'customer' | 'public';
  sub?: string;
  role?: Role;
  ver?: number;
  stayId?: string;
}

export const userObjectId = (p: Principal) => new Types.ObjectId(p.userId);
