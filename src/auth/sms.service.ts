import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../common/errors';

@Injectable()
export class SmsService {
  private readonly logger = new Logger('OTP');

  constructor(private readonly config: ConfigService) {}

  async sendOtp(phone: string, otp: string): Promise<void> {
    const provider = this.config.get<string>('OTP_PROVIDER', 'console');
    if (provider === 'console') {
      // validateEnv rejects this provider in production.
      this.logger.log(`OTP for ${phone}: ${otp}`);
      return;
    }
    await this.sendViaMsg91(phone, otp);
  }

  private async sendViaMsg91(phone: string, otp: string): Promise<void> {
    const authkey = this.config.get<string>('SMS_API_KEY');
    const templateId = this.config.get<string>('SMS_TEMPLATE_ID');
    const unavailable = new ApiError(503, 'SMS_UNAVAILABLE', 'Could not send the OTP, please contact the front desk');
    if (!authkey || !templateId) {
      this.logger.error('SMS_API_KEY or SMS_TEMPLATE_ID is not set');
      throw unavailable;
    }
    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.search = new URLSearchParams({ template_id: templateId, mobile: `91${phone}`, otp }).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: { authkey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res?.ok) {
      this.logger.error(`msg91 send failed with status ${res?.status ?? 'network error'}`);
      throw unavailable;
    }
  }
}
