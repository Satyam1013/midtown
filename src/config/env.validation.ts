import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export class EnvironmentVariables {
  @IsInt() @Min(1) @Max(65535)
  PORT: number = 3000;

  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsString() @IsNotEmpty()
  HOTEL_TIMEZONE = 'Asia/Kolkata';

  @IsString() @IsNotEmpty()
  MONGODB_URI: string;

  @IsInt() @Min(1) @Max(500)
  MONGODB_MAX_POOL_SIZE: number = 20;

  @IsString() @MinLength(32)
  JWT_ACCESS_SECRET: string;

  @IsString() @MinLength(32)
  JWT_REFRESH_SECRET: string;

  @IsString() @IsNotEmpty()
  JWT_ACCESS_EXPIRES_IN = '12h';

  @IsString() @IsNotEmpty()
  JWT_REFRESH_EXPIRES_IN = '30d';

  @IsString() @IsNotEmpty()
  OWNER_NAME: string;

  @IsString() @IsNotEmpty()
  OWNER_PHONE: string;

  @IsOptional() @IsString()
  OWNER_EMAIL?: string;

  @IsString() @MinLength(8)
  OWNER_PASSWORD: string;

  @IsInt() @Min(1) @Max(30)
  OTP_EXPIRY_MINUTES: number = 5;

  @IsIn(['console', 'msg91'])
  OTP_PROVIDER = 'console';

  @IsOptional() @IsString()
  SMS_API_KEY?: string;

  @IsOptional() @IsString()
  SMS_SENDER_ID?: string;

  @IsOptional() @IsString()
  SMS_TEMPLATE_ID?: string;

  @IsOptional() @IsString()
  FRONTEND_MANAGER_URL?: string;

  @IsOptional() @IsString()
  FRONTEND_GUEST_URL?: string;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, config, { enableImplicitConversion: true });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length) {
    const lines = errors.map((e) => `  ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  if (env.NODE_ENV === NodeEnv.Production && env.OTP_PROVIDER === 'console') {
    throw new Error('OTP_PROVIDER=console is not allowed in production');
  }
  return env;
}
