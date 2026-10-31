import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BUSINESS_DATE_RE } from '../dto/common.dto';
import { Role } from '../enums';
import { badRequest } from '../errors';
import { Principal } from '../interfaces/principal';

const MAX_DAYS_BACK = 7;

@Injectable()
export class BusinessDateService {
  private readonly timeZone: string;

  constructor(config: ConfigService) {
    this.timeZone = config.get<string>('HOTEL_TIMEZONE', 'Asia/Kolkata');
  }

  /** Today's calendar date in the hotel's timezone. */
  today(now = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone }).format(now);
  }

  nowTime(now = new Date()): string {
    return new Intl.DateTimeFormat('en-GB', { timeZone: this.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  }

  addDays(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  }

  isRealDate(date: string): boolean {
    if (!BUSINESS_DATE_RE.test(date)) return false;
    const d = new Date(`${date}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
  }

  /** Not in the future and at most seven days back; OWNER may override both. */
  assertAllowed(date: string, user: Principal): void {
    if (!this.isRealDate(date)) throw badRequest('INVALID_DATE', 'Business date must be a real YYYY-MM-DD date');
    if (user.role === Role.OWNER) return;
    const today = this.today();
    if (date > today) throw badRequest('FUTURE_DATE', 'Business date cannot be in the future');
    if (date < this.addDays(today, -MAX_DAYS_BACK)) {
      throw badRequest('DATE_TOO_OLD', `Business date cannot be more than ${MAX_DAYS_BACK} days old`);
    }
  }
}
