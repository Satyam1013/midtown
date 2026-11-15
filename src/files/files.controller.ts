import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators';
import { ImageStorageService } from './image-storage.service';

@ApiTags('Files')
@Controller('files')
export class ImagesController {
  constructor(private readonly images: ImageStorageService) {}

  /** Room and menu photos: public, cacheable. */
  @Public()
  @Get('images/:id')
  async image(@Param('id') id: string, @Res() res: { set(h: Record<string, string>): void; destroy(): void } & NodeJS.WritableStream) {
    const file = await this.images.open(id);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Length': String(file.size),
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    file.stream.on('error', () => res.destroy()).pipe(res);
  }
}
