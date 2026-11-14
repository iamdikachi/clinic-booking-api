import { BadRequestException, Injectable } from '@nestjs/common';
import { formatIsoUtc } from '../common/utils/date.util';
import { DatabaseService } from '../database/database.service';
import type { SlotDto, SlotsListResponseDto } from './dto/slot.dto';

interface SlotRow {
  id: string;
  provider: string;
  start_time: Date | string;
  end_time: Date | string;
  available: boolean;
}

/**
 * Reads appointment slots and computes availability from confirmed bookings.
 */
@Injectable()
export class SlotsService {
  constructor(private readonly db: DatabaseService) {}

  async findAll(provider?: string | string[]): Promise<SlotsListResponseDto> {
    if (Array.isArray(provider)) {
      throw new BadRequestException('provider must be a string');
    }

    const trimmedProvider =
      typeof provider === 'string' ? provider.trim() : '';

    const params: unknown[] = [];
    const whereClause =
      trimmedProvider.length > 0
        ? (params.push(trimmedProvider), 'WHERE s.provider = $1')
        : '';

    const result = await this.db.query<SlotRow>(
      `SELECT
         s.id,
         s.provider,
         s.start_time,
         s.end_time,
         NOT EXISTS (
           SELECT 1
           FROM bookings b
           WHERE b.slot_id = s.id AND b.status = 'confirmed'
         ) AS available
       FROM slots s
       ${whereClause}
       ORDER BY s.start_time ASC, s.id ASC`,
      params,
    );

    const slots: SlotDto[] = result.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      start: formatIsoUtc(row.start_time),
      end: formatIsoUtc(row.end_time),
      available: row.available,
    }));

    return { slots };
  }
}
