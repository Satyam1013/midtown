// Enums shared by more than one domain. Values are the exact strings the
// front-ends use, so they are stored and returned verbatim.

export enum Role {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  STAFF = 'STAFF',
  KITCHEN = 'KITCHEN',
  GUEST = 'GUEST',
  /** Restricted public token: guest app visitor without an active stay. */
  VISITOR = 'VISITOR',
}

export const ALL_STAFF = [Role.OWNER, Role.MANAGER, Role.STAFF, Role.KITCHEN];
export const DESK = [Role.OWNER, Role.MANAGER, Role.STAFF];
export const MANAGEMENT = [Role.OWNER, Role.MANAGER];

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
