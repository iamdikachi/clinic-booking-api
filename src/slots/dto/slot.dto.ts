import { ApiProperty } from '@nestjs/swagger';

export class SlotDto {
  @ApiProperty({ example: 'slot-1' })
  id: string;

  @ApiProperty({ example: 'dr-smith' })
  provider: string;

  @ApiProperty({ example: '2026-12-10T09:00:00Z' })
  start: string;

  @ApiProperty({ example: '2026-12-10T09:30:00Z' })
  end: string;

  @ApiProperty({ example: true })
  available: boolean;
}

export class SlotsListResponseDto {
  @ApiProperty({ type: [SlotDto] })
  slots: SlotDto[];
}
