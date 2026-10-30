import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModuleFactoryOptions } from '@nestjs/mongoose';
import mongoose, { Connection } from 'mongoose';

const logger = new Logger('MongoDB');

// Fail loudly on queries against fields that aren't in the schema rather
// than silently matching everything.
mongoose.set('strictQuery', true);

export function mongooseOptionsFactory(config: ConfigService): MongooseModuleFactoryOptions {
  const isProd = config.get('NODE_ENV') === 'production';
  return {
    uri: config.getOrThrow<string>('MONGODB_URI'),
    maxPoolSize: config.get<number>('MONGODB_MAX_POOL_SIZE', 20),
    minPoolSize: isProd ? 2 : 0,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    retryWrites: true,
    retryReads: true,
    writeConcern: { w: 'majority' },
    readPreference: 'primary',
    // Indexes are built at startup and by the seed script. They are
    // declared once in the schemas; there is no separate migration step.
    autoIndex: true,
    autoCreate: true,
    connectionFactory: (connection: Connection) => {
      connection.on('disconnected', () => logger.warn('disconnected; driver will reconnect'));
      connection.on('reconnected', () => logger.log('reconnected'));
      connection.on('error', (err) => logger.error(`connection error: ${err.message}`));
      return connection;
    },
  };
}
