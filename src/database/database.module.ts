import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { CounterService } from './counter.service';
import { DatabaseHealthService } from './database-health.service';
import { ModelsModule } from './models.module';
import { mongooseOptionsFactory } from './mongoose.config';
import { Counter, CounterSchema } from './schemas/counter.schema';
import { TransactionService } from './transaction.service';

@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({ inject: [ConfigService], useFactory: mongooseOptionsFactory }),
    MongooseModule.forFeature([{ name: Counter.name, schema: CounterSchema }]),
    ModelsModule,
  ],
  providers: [TransactionService, CounterService, DatabaseHealthService],
  exports: [TransactionService, CounterService, DatabaseHealthService],
})
export class DatabaseModule {}
