import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { FolioModule } from '../folio/folio.module';
import { DaybookModule } from '../daybook/daybook.module';
import { EntriesModule } from '../entries/entries.module';
import { StaysController } from './stays.controller';
import { StayViewService } from './stay-view.service';
import { StaysService } from './stays.service';
import { StayBillService } from './stay-bill.service';

@Module({ imports: [FolioModule, DaybookModule, EntriesModule], controllers: [StaysController], providers: [StaysService, StayViewService, StayBillService], exports: [StaysService, StayViewService, StayBillService] })
export class StaysModule implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** Drops the old unique index that allowed only one shift without a request. Idempotent. */
  async onModuleInit() {
    try {
      const shifts = this.connection.collection('room_shifts');
      if ((await shifts.indexes()).some((i) => i.name === 'requestId_1')) {
        await shifts.dropIndex('requestId_1');
        new Logger('StaysModule').log('dropped legacy index room_shifts.requestId_1');
      }
    } catch (err: any) {
      // A missing collection (fresh database) has no index to drop.
      if (err?.codeName !== 'NamespaceNotFound') throw err;
    }
  }
}
