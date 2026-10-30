// Enums shared by more than one domain. Values are the exact strings the
// front-ends use, so they are stored and returned verbatim.

export enum Role {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  STAFF = 'STAFF',
  KITCHEN = 'KITCHEN',
  GUEST = 'GUEST',
}

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
