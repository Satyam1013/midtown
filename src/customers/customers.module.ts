import { Global, Module } from '@nestjs/common';
import { DaybookModule } from '../daybook/daybook.module';
import { EntriesModule } from '../entries/entries.module';
import { CustomerCreditService } from './customer-credit.service';
import { CustomerDocumentsService } from './customer-documents.service';
import { CustomerFilesController, CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Global()
@Module({
  imports: [DaybookModule, EntriesModule],
  controllers: [CustomersController, CustomerFilesController],
  providers: [CustomersService, CustomerDocumentsService, CustomerCreditService],
  exports: [CustomersService, CustomerCreditService],
})
export class CustomersModule {}
