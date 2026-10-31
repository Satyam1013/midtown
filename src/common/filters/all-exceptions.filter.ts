import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Error as MongooseError } from 'mongoose';

const CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
};

// Every error leaves as { statusCode, code, message, ...extra }.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(err: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest();
    const res = ctx.getResponse();
    const body = this.toBody(err);
    if (body.statusCode >= 500) {
      this.logger.error(`[${req.correlationId}] ${req.method} ${req.path}: ${err?.stack ?? err}`);
    }
    res.status(body.statusCode).json(body);
  }

  private toBody(err: any): { statusCode: number; code: string; message: string } & Record<string, unknown> {
    if (err instanceof HttpException) {
      const statusCode = err.getStatus();
      const r = err.getResponse();
      if (typeof r === 'string') return { statusCode, code: CODES[statusCode] ?? 'ERROR', message: r };
      const { message, code, error: _error, statusCode: _s, ...extra } = r as Record<string, any>;
      const isValidation = Array.isArray(message);
      return {
        statusCode,
        code: code ?? (isValidation ? 'VALIDATION_ERROR' : CODES[statusCode] ?? 'ERROR'),
        message: isValidation ? message.join('; ') : message ?? err.message,
        ...extra,
      };
    }
    if (err?.code === 11000) {
      return { statusCode: 409, code: 'DUPLICATE', message: 'A record with these details already exists' };
    }
    if (err instanceof MongooseError.ValidationError || err instanceof MongooseError.CastError) {
      return { statusCode: 400, code: 'VALIDATION_ERROR', message: err.message };
    }
    return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL_ERROR', message: 'Something went wrong' };
  }
}
