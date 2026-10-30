import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Connection } from 'mongoose';

export interface TxContext {
  session: ClientSession;
  /**
   * Queue work (socket emits, SMS) to run only after the transaction has
   * committed. Discarded if the transaction aborts or is retried.
   */
  afterCommit(fn: () => void | Promise<void>): void;
}

// Every multi-document financial write goes through run(). There is no
// non-transactional fallback: if the deployment can't do transactions the
// app refuses to start (see DatabaseHealthService).
@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  /**
   * Runs `work` in a transaction via session.withTransaction(), which retries
   * the whole callback on TransientTransactionError and retries the commit on
   * UnknownTransactionCommitResult. `work` may therefore run more than once
   * and must not have side effects outside the session — use afterCommit().
   */
  async run<T>(work: (tx: TxContext) => Promise<T>): Promise<T> {
    const session = await this.connection.startSession();
    let pending: Array<() => void | Promise<void>> = [];
    let result!: T;
    try {
      await session.withTransaction(
        async () => {
          pending = []; // fresh queue for each attempt
          result = await work({ session, afterCommit: (fn) => pending.push(fn) });
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        },
      );
    } finally {
      await session.endSession();
    }
    for (const fn of pending) {
      try {
        await fn();
      } catch (err) {
        // Committed data stands; a failed broadcast must not turn into a 500.
        this.logger.error(`afterCommit hook failed: ${(err as Error).message}`);
      }
    }
    return result;
  }
}
