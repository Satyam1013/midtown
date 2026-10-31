import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsMongoId, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateIf, ValidateNested } from 'class-validator';
import { DateQueryDto, IsBusinessDate, IsDecimal } from '../../common/dto/common.dto';

export enum InvoiceLineKind {
  ROOM = 'ROOM',
  FOOD = 'FOOD',
}

export class InvoiceLineDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  @ApiProperty({ type: String })
  description: string;

  @IsEnum(InvoiceLineKind)
  @ApiProperty({ enum: InvoiceLineKind })
  kind: InvoiceLineKind;

  @IsDecimal({ positive: true })
  @ApiProperty({ type: String })
  qty: string;

  @IsDecimal({ min: '0' })
  @ApiProperty({ type: String })
  rate: string;
}

export class CreateInvoiceDto {
  @IsBusinessDate()
  @ApiProperty({ type: String })
  businessDate: string;

  @IsString() @IsNotEmpty() @MaxLength(150)
  @ApiProperty({ type: String })
  party: string;

  @IsOptional() @ValidateIf((o) => o.partyGstin) @IsString()
  @Matches(/^[0-9A-Za-z]{15}$/, { message: 'partyGstin must be a 15-character GSTIN' })
  @ApiPropertyOptional({ type: String, nullable: true })
  partyGstin?: string | null;

  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String, nullable: true })
  stayId?: string | null;

  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => InvoiceLineDto)
  @ApiProperty({ type: [InvoiceLineDto] })
  lines: InvoiceLineDto[];
}

export class InvoiceQueryDto extends DateQueryDto {
  @IsOptional() @IsMongoId()
  @ApiPropertyOptional({ type: String })
  stayId?: string;
}
