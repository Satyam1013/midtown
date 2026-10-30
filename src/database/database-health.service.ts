import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Injectable()
export class DatabaseHealthService implements OnApplicationBootstrap {
  private readonly logger = new Logger('MongoDB');

  constructor(@InjectConnection() private readonly connection: Connection) {}

  async onApplicationBootstrap(): Promise<void> {
    await assertTransactionsSupported(this.connection);
    this.logger.log(`connected to replica set, db=${this.connection.name}`);
  }

  async ping(): Promise<boolean> {
    try {
      await this.connection.db!.admin().ping();
      return true;
    } catch {
      return false;
    }
  }
}

/** Transactions need a replica set or sharded cluster; refuse anything else. */
export async function assertTransactionsSupported(connection: Connection): Promise<void> {
  const hello = await connection.db!.admin().command({ hello: 1 });
  const isReplicaSet = typeof hello.setName === 'string';
  const isMongos = hello.msg === 'isdbgrid';
  if (!isReplicaSet && !isMongos) {
    throw new Error(
      'MongoDB is a standalone server. Transactions require a replica set ' +
        '(run `docker compose up -d mongodb` locally, or use MongoDB Atlas).',
    );
  }
}
