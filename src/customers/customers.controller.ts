import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { CurrentUser, Public, Roles } from '../common/decorators';
import { DESK, MANAGEMENT } from '../common/enums';
import { Principal } from '../common/interfaces/principal';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CustomerDocumentsService, MAX_DOCUMENT_BYTES, UploadedFileLike } from './customer-documents.service';
import { CustomersService } from './customers.service';
import { CustomerListQueryDto, LookupQueryDto, MergeCustomerDto, SignedLinkQueryDto, UpdateCustomerDto, UploadDocumentDto } from './dto/customer.dto';

@ApiTags('Customers')
@ApiBearerAuth()
@Roles(...DESK)
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly documents: CustomerDocumentsService,
  ) {}

  /** 200 with `{ customer: null }` for a phone not seen before. */
  @Get('lookup')
  lookup(@Query() q: LookupQueryDto) {
    return this.customers.lookup(q.phone);
  }

  @Get()
  list(@Query() q: CustomerListQueryDto) {
    return this.customers.list(q);
  }

  @Get(':id')
  detail(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @CurrentUser() user: Principal) {
    return this.customers.detail(id, user);
  }

  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateCustomerDto, @CurrentUser() user: Principal) {
    return this.customers.update(id, dto, user);
  }

  @Roles(...MANAGEMENT)
  @HttpCode(200)
  @Post(':id/merge')
  merge(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: MergeCustomerDto, @CurrentUser() user: Principal) {
    return this.customers.merge(id, dto.intoCustomerId, user);
  }

  @Get(':id/documents')
  documentsOf(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @CurrentUser() user: Principal) {
    return this.documents.list(id, user);
  }

  @ApiConsumes('multipart/form-data')
  @Post(':id/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } }))
  upload(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: UploadedFileLike | undefined,
    @CurrentUser() user: Principal,
  ) {
    return this.documents.upload(id, dto.type, dto.number, file, user);
  }

  @Roles(...MANAGEMENT)
  @Delete(':id/documents/:docId')
  removeDocument(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Param('docId', ParseObjectIdPipe) docId: Types.ObjectId,
    @CurrentUser() user: Principal,
  ) {
    return this.documents.remove(id, docId, user);
  }
}

/** ID files, only through the signed, short-lived links in document responses. */
@ApiTags('Customers')
@Controller('files')
export class CustomerFilesController {
  constructor(private readonly documents: CustomerDocumentsService) {}

  @Public()
  @Get('customer-documents/:docId')
  async file(@Param('docId') docId: string, @Query() q: SignedLinkQueryDto, @Res() res: { set(h: Record<string, string>): void; destroy(): void } & NodeJS.WritableStream) {
    const file = await this.documents.open(docId, q.exp, q.u, q.sig);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Length': String(file.size),
      'Content-Disposition': `inline; filename="${file.fileName.replace(/[^\w.\- ]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    file.stream.on('error', () => res.destroy()).pipe(res);
  }
}
