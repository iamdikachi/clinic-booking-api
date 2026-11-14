import { ApiProperty } from '@nestjs/swagger';
import { formatIsoUtc } from '../../common/utils/date.util';

export interface BookingRow {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: string;
  created_at: Date | string;
}

export class BookingDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  id: string;

  @ApiProperty({ example: 'slot-1' })
  slot_id: string;

  @ApiProperty({ example: 'Alice Johnson' })
  name: string;

  @ApiProperty({ example: 'alice@example.com' })
  email: string;

  @ApiProperty({ enum: ['confirmed', 'cancelled'], example: 'confirmed' })
  status: string;

  @ApiProperty({ example: '2026-12-10T09:00:00Z' })
  created_at: string;
}

export function toBookingDto(row: BookingRow): BookingDto {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: formatIsoUtc(row.created_at),
  };
}
