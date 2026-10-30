import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FolioLine, FolioLineSchema } from './schemas/folio-line.schema';

// Phase 1: model registration only. Controller and service come next phase.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FolioLine.name, schema: FolioLineSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class FolioModule {}
