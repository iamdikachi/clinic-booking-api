import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { ResetResponseDto, ResetSlotDto } from './dto/reset.dto';

interface NormalizedSlot {
  id: string;
  provider: string;
  startIso: string;
  endIso: string;
}

/**
 * Resets all booking/rate-limit state and seeds the provided slots in a single transaction.
 */
@Injectable()
export class ResetService {
  constructor(private readonly db: DatabaseService) {}

  async reset(body: unknown): Promise<ResetResponseDto> {
    const slots = this.parseAndValidateSlots(body);

    await this.db.withTransaction(async (client) => {
      await client.query('DELETE FROM bookings');
      await client.query('DELETE FROM slots');
      await client.query('DELETE FROM idempotency_keys');
      await client.query('DELETE FROM attempts');

      if (slots.length > 0) {
        const ids = slots.map((s) => s.id);
        const providers = slots.map((s) => s.provider);
        const starts = slots.map((s) => s.startIso);
        const ends = slots.map((s) => s.endIso);

        await client.query(
          `INSERT INTO slots (id, provider, start_time, end_time)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[])`,
          [ids, providers, starts, ends],
        );
      }
    });

    return { ok: true, slots_created: slots.length };
  }

  private parseAndValidateSlots(body: unknown): NormalizedSlot[] {
    if (body === undefined) {
      return [];
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('request body must be an object');
    }

    const rawSlots = (body as { slots?: unknown }).slots;
    if (rawSlots === undefined) {
      return [];
    }

    if (!Array.isArray(rawSlots)) {
      throw new BadRequestException('slots must be an array');
    }

    const seenIds = new Set<string>();
    const normalized: NormalizedSlot[] = [];

    for (let i = 0; i < rawSlots.length; i++) {
      const entry = rawSlots[i] as Partial<ResetSlotDto> | null | undefined;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new BadRequestException(`slots[${i}] must be an object`);
      }

      const id = this.requireNonEmptyString(entry.id, `slots[${i}].id`);
      if (seenIds.has(id)) {
        throw new BadRequestException(`duplicate slot id: ${id}`);
      }
      seenIds.add(id);

      const provider = this.requireNonEmptyString(
        entry.provider,
        `slots[${i}].provider`,
      );
      const startIso = this.requireValidTimestamp(
        entry.start,
        `slots[${i}].start`,
      );
      const endIso = this.requireValidTimestamp(entry.end, `slots[${i}].end`);

      normalized.push({ id, provider, startIso, endIso });
    }

    return normalized;
  }

  private requireNonEmptyString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(`${field} must be a non-empty string`);
    }
    return value.trim();
  }

  private requireValidTimestamp(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(
        `${field} must be a valid ISO timestamp string`,
      );
    }
    const parsed = new Date(value.trim());
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(
        `${field} must be a valid ISO timestamp string`,
      );
    }
    return parsed.toISOString();
  }
}
