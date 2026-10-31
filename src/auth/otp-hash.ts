import { createHmac } from 'crypto';

export const hashOtp = (otp: string, secret: string) => createHmac('sha256', secret).update(otp).digest('hex');
