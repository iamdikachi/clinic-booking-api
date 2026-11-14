import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ResetSlotDto {
  @ApiProperty({ example: 'slot-1' })
  id: string;

  @ApiProperty({ example: 'dr-smith' })
  provider: string;

  @ApiProperty({ example: '2026-12-10T09:00:00Z' })
  start: string;

  @ApiProperty({ example: '2026-12-10T09:30:00Z' })
  end: string;
}

export class ResetRequestDto {
  @ApiPropertyOptional({ type: [ResetSlotDto] })
  slots?: ResetSlotDto[];
}

export class ResetResponseDto {
  @ApiProperty({ example: true })
  ok: boolean;

  @ApiProperty({ example: 2 })
  slots_created: number;
}
