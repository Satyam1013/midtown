import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsEnum, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { DocumentType } from '../schemas/customer-document.schema';

export class LookupQueryDto {
  @ApiProperty({ type: String })
  @IsString() @MaxLength(20)
  phone: string;
}

export class CustomerListQueryDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(60)
  search?: string;

  @ApiPropertyOptional({ type: Number })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  /** `meta.nextCursor` from the previous page. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({ enum: ['repeat', 'nodoc', 'all'] })
  @IsOptional() @IsIn(['repeat', 'nodoc', 'all'])
  filter?: 'repeat' | 'nodoc' | 'all';
}

export class UpdateCustomerDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @IsString() @MaxLength(20)
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @ValidateIf((o) => o.email !== '' && o.email !== null) @IsEmail() @MaxLength(120)
  email?: string | null;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(1000)
  notes?: string;
}

export class MergeCustomerDto {
  @ApiProperty({ type: String })
  @IsMongoId()
  intoCustomerId: string;
}

export class UploadDocumentDto {
  @ApiProperty({ enum: DocumentType })
  @IsEnum(DocumentType)
  type: DocumentType;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(40)
  number?: string;
}

export class SignedLinkQueryDto {
  @IsString() exp: string;
  @IsString() u: string;
  @IsString() sig: string;
}
