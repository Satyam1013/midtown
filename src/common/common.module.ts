import { Global, Module } from '@nestjs/common';
import { BusinessDateService } from './services/business-date.service';
import { GstService } from './services/gst.service';
import { TaxService } from './services/tax.service';

@Global()
@Module({ providers: [BusinessDateService, TaxService, GstService], exports: [BusinessDateService, TaxService, GstService] })
export class CommonModule {}
