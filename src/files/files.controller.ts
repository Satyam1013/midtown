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
  async image(@Param('id') id: string, @Res() res: { set(h: Record<string, string>): void; destroy(): void; redirect(status: number, url: string): void } & NodeJS.WritableStream) {
    const file = await this.images.open(id);
    // Photos moved to Spaces: older links in saved records keep working.
    if ('redirect' in file) return res.redirect(301, file.redirect);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Length': String(file.size),
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    file.stream.on('error', () => res.destroy()).pipe(res);
  }
}
