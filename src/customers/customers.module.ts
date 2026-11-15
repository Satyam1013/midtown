import { Global, Module } from '@nestjs/common';
import { CustomerDocumentsService } from './customer-documents.service';
import { CustomerFilesController, CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Global()
@Module({
  controllers: [CustomersController, CustomerFilesController],
  providers: [CustomersService, CustomerDocumentsService],
  exports: [CustomersService],
})
export class CustomersModule {}
