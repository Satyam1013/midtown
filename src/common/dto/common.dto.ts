import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { registerDecorator, IsInt, IsOptional, Matches, Max, Min, ValidationOptions } from 'class-validator';

export const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const IsBusinessDate = () => Matches(BUSINESS_DATE_RE, { message: '$property must be YYYY-MM-DD' });
export const IsClockTime = () => Matches(/^\d{2}:\d{2}$/, { message: '$property must be HH:mm' });

/** Decimal string or number; turned into a string so it never lives on as a float. */
export function IsDecimal(opts: { min?: string; positive?: boolean } = {}, validation?: ValidationOptions) {
  return (target: object, propertyName: string) => {
    Transform(({ value }) => (typeof value === 'number' ? String(value) : value))(target, propertyName);
    registerDecorator({
      name: 'isDecimal',
      target: target.constructor,
      propertyName,
      options: validation,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string' || !/^-?\d{1,12}(\.\d{1,4})?$/.test(value)) return false;
          const n = Number(value); // range check only, never used as an amount
          if (opts.positive && !(n > 0)) return false;
          if (opts.min !== undefined && n < Number(opts.min)) return false;
          return true;
        },
        defaultMessage: () => `${propertyName} must be a valid ${opts.positive ? 'positive ' : ''}amount`,
      },
    });
  };
}

export class PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  @ApiPropertyOptional({ type: Number })
  page?: number;

  // The apps load whole lists without paging, so the default is generous.
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  @ApiPropertyOptional({ type: Number })
  limit?: number;
}

export class DateQueryDto extends PageQueryDto {
  @IsOptional() @IsBusinessDate()
  @ApiPropertyOptional({ type: String })
  date?: string;
}

export const pageOf = (q: PageQueryDto) => {
  const page = q.page ?? 1;
  const limit = q.limit ?? 200;
  return { page, limit, skip: (page - 1) * limit };
};
