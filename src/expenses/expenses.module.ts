import { Module } from '@nestjs/common';
import { DaybookModule } from '../daybook/daybook.module';
import { EntriesModule } from '../entries/entries.module';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({ imports: [DaybookModule, EntriesModule], controllers: [ExpensesController], providers: [ExpensesService], exports: [ExpensesService] })
export class ExpensesModule {}
