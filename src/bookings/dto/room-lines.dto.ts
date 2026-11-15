import { ApiProperty } from '@nestjs/swagger';
import { plainToInstance, Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsMongoId, Max, Min, ValidateNested } from 'class-validator';
import { MAX_GUESTS, splitGuests } from '../../config/pricing';

/** One physical room in a booking. */
export class RoomLineDto {
  @IsMongoId()
  @ApiProperty({ type: String })
  roomTypeId: string;

  @IsInt() @Min(1, { message: 'Each room needs at least one guest' }) @Max(MAX_GUESTS)
  @ApiProperty({ type: Number })
  guests: number;
}

/**
 * `rooms` as an array of { roomTypeId, guests }. The older shape (roomTypeId,
 * rooms as a number, pax) is turned into lines here, guests split evenly with
 * earlier rooms first, so older apps keep working.
 */
export function RoomLines() {
  const toLines = Transform(({ value, obj }) => {
    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
      const count = Number(value);
      if (!obj.roomTypeId || count < 1) return value;
      // Never a 0-guest line: too few guests is reported by the pricing with its own message.
      return splitGuests(Number(obj.pax ?? count), count).map((guests) => plainToInstance(RoomLineDto, { roomTypeId: obj.roomTypeId, guests: Math.max(1, guests) }));
    }
    return Array.isArray(value) ? value.map((v) => plainToInstance(RoomLineDto, v)) : value;
  });
  return (target: object, key: string) => {
    toLines(target, key);
    // The 10-room limit is checked by the service, with the bulk-booking message.
    IsArray({ message: 'rooms must be a list of { roomTypeId, guests }' })(target, key);
    ArrayMinSize(1)(target, key);
    ArrayMaxSize(50)(target, key);
    ValidateNested({ each: true })(target, key);
  };
}
