import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsEnum, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { DocumentType } from '../schemas/customer-document.schema';
import { CreditKind } from '../schemas/customer-credit-entry.schema';
import { IsBusinessDate, IsClockTime, IsDecimal } from '../../common/dto/common.dto';
import { PaymentMode } from '../../common/enums';

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

  /** true: only customers who owe money. */
  @ApiPropertyOptional({ type: String, enum: ['true', 'false'] })
  @IsOptional() @IsIn(['true', 'false'])
  hasCredit?: 'true' | 'false';

  /** Same as hasCredit: true lists only customers with dueAmount > 0. */
  @ApiPropertyOptional({ type: String, enum: ['true', 'false'] })
  @IsOptional() @IsIn(['true', 'false'])
  hasDue?: 'true' | 'false';

  /** recent (default): last visit first. due_desc: most owed first. */
  @ApiPropertyOptional({ enum: ['recent', 'due_desc'] })
  @IsOptional() @IsIn(['recent', 'due_desc'])
  sort?: 'recent' | 'due_desc';
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

export class CreditEntryDto {
  @ApiProperty({ enum: CreditKind })
  @IsEnum(CreditKind)
  kind: CreditKind;

  @ApiProperty({ type: String })
  @IsDecimal({ positive: true })
  amount: string;

  /** PAYMENT only. */
  @ApiPropertyOptional({ enum: PaymentMode })
  @IsOptional() @IsEnum(PaymentMode)
  mode?: PaymentMode;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsString() @MaxLength(300)
  narration?: string;

  /** CHARGE: the date it's for (default: the open day). PAYMENT: ignored, the open business day is used. */
  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsBusinessDate()
  businessDate?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional() @IsClockTime()
  time?: string;
}
