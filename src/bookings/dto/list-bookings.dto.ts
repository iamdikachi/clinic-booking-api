import { ApiProperty } from '@nestjs/swagger';
import { BookingDto } from './booking.dto';

export class BookingsListResponseDto {
  @ApiProperty({ type: [BookingDto] })
  bookings: BookingDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'MTA',
    description: 'Opaque cursor for the next page, or null when at the end',
  })
  next_cursor: string | null;
}
