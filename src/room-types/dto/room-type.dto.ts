import { ApiProperty } from '@nestjs/swagger';
import { IsDecimal } from '../../common/dto/common.dto';

export class UpdateTariffDto {
  @IsDecimal({ positive: true })
  @ApiProperty({ type: String })
  tariff: string;
}
