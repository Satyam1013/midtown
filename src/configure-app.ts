import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { originsFromEnv } from './notifications/notifications.gateway';

/** Everything global, shared by main.ts and the integration tests. */
export function configureApp(app: INestApplication) {
  const config = app.get(ConfigService);
  (app as any).set?.('trust proxy', 1); // Render's proxy: rate limits must see the real client IP
  app.use(helmet({ contentSecurityPolicy: config.get('NODE_ENV') === 'production' ? undefined : false }));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors({ origin: originsFromEnv(), credentials: true });
  app.enableShutdownHooks();
}
