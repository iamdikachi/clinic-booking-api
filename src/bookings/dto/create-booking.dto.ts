import { ApiProperty } from '@nestjs/swagger';

export class CreateBookingDto {
  @ApiProperty({ example: 'slot-1' })
  slot_id: string;

  @ApiProperty({ example: 'Alice Johnson' })
  name: string;

  @ApiProperty({ example: 'alice@example.com' })
  email: string;
}
