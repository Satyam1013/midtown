import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { DaybookModule } from '../daybook/daybook.module';
import { EntriesController } from './entries.controller';
import { EntriesService } from './entries.service';
import { LedgerService } from './ledger.service';

@Module({ imports: [DaybookModule], controllers: [EntriesController], providers: [EntriesService, LedgerService], exports: [EntriesService, LedgerService] })
export class EntriesModule implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /**
   * Moves the no-duplicate index to v2 (which skips split checkout rows).
   * Older entries get dupCheck = true so v2 still covers them. Idempotent.
   */
  async onModuleInit() {
    const entries = this.connection.collection('day_register_entries');
    try {
      await entries.updateMany({ dupCheck: { $exists: false } }, { $set: { dupCheck: true } });
      if ((await entries.indexes()).some((i) => i.name === 'no_duplicate_entry')) {
        await entries.dropIndex('no_duplicate_entry');
        new Logger('EntriesModule').log('dropped legacy index day_register_entries.no_duplicate_entry');
      }
    } catch (err: any) {
      if (err?.codeName !== 'NamespaceNotFound') throw err;
    }
  }
}
