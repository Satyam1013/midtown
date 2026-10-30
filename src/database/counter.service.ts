import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { Counter } from './schemas/counter.schema';

@Injectable()
export class CounterService {
  constructor(@InjectModel(Counter.name) private readonly counters: Model<Counter>) {}

  /** Next value of a sequence. Must run inside a transaction. */
  async next(key: string, session: ClientSession): Promise<number> {
    if (!session.inTransaction()) {
      throw new Error(`CounterService.next('${key}') called outside a transaction`);
    }
    const doc = await this.counters.findOneAndUpdate(
      { key },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, session, setDefaultsOnInsert: false },
    );
    return doc!.seq;
  }
}
