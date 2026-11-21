// Enums shared by more than one domain. Values are the exact strings the
// front-ends use, so they are stored and returned verbatim.

export enum Role {
  ADMIN = 'ADMIN',
  MANAGER = 'MANAGER',
  STAFF = 'STAFF',
  KITCHEN = 'KITCHEN',
  GUEST = 'GUEST',
  /** Restricted public token: guest app visitor without an active stay. */
  VISITOR = 'VISITOR',
}

/** Owner accounts stored before the ADMIN rename; read as ADMIN until migrate:roles runs. */
export const LEGACY_OWNER = 'OWNER';

/** A stored staff role as the API uses it. */
export const staffRole = (stored: string): Role => (stored === LEGACY_OWNER ? Role.ADMIN : (stored as Role));

export const ALL_STAFF = [Role.ADMIN, Role.MANAGER, Role.STAFF, Role.KITCHEN];
export const DESK = [Role.ADMIN, Role.MANAGER, Role.STAFF];
export const MANAGEMENT = [Role.ADMIN, Role.MANAGER];

export enum PaymentMode {
  CASH = 'CASH',
  UPI = 'UPI',
  CARD = 'CARD',
  BANK = 'BANK',
}

export enum DebitCredit {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}
