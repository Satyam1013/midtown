import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';

// Logs method, path, status and time only: never bodies, tokens or query
// strings, which can hold phone numbers.
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: any, res: any, next: () => void) {
    const incoming = req.headers['x-correlation-id'];
    const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    req.correlationId = id;
    res.setHeader('x-correlation-id', id);
    const start = Date.now();
    res.on('finish', () => {
      this.logger.log(`[${id}] ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  }
}
