import { Global, Module } from '@nestjs/common';
import { BusinessDateService } from './services/business-date.service';
import { TaxService } from './services/tax.service';

@Global()
@Module({ providers: [BusinessDateService, TaxService], exports: [BusinessDateService, TaxService] })
export class CommonModule {}
