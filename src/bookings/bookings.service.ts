import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { RateLimitException } from '../common/exceptions/rate-limit.exception';
import { hashNormalizedJson } from '../common/utils/hash.util';
import { DatabaseService } from '../database/database.service';
import {
  type BookingDto,
  type BookingRow,
  toBookingDto,
} from './dto/booking.dto';
import type { BookingsListResponseDto } from './dto/list-bookings.dto';

const MAX_ATTEMPTS_PER_WINDOW = 5;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 50;
const MAX_PG_BIGINT = 9223372036854775807n;

interface BookingWithSeqRow extends BookingRow {
  seq: string;
}

function encodeCursor(seq: string): string {
  return Buffer.from(seq, 'utf8').toString('base64url');
}

function decodeCursor(rawCursor: unknown): string | undefined {
  if (rawCursor === undefined) {
    return undefined;
  }
  if (Array.isArray(rawCursor) || typeof rawCursor !== 'string') {
    throw new BadRequestException('cursor must be a valid string');
  }
  const trimmed = rawCursor.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new BadRequestException('invalid cursor');
  }
  const decoded = Buffer.from(trimmed, 'base64url').toString('utf8');
  if (
    Buffer.from(decoded, 'utf8').toString('base64url') !== trimmed ||
    !/^\d+$/.test(decoded)
  ) {
    throw new BadRequestException('invalid cursor');
  }
  const seq = BigInt(decoded);
  if (seq < 1n || seq > MAX_PG_BIGINT || seq.toString() !== decoded) {
    throw new BadRequestException('invalid cursor');
  }
  return decoded;
}

export interface BookingAttemptOutcome {
  statusCode: number;
  body: BookingDto | { error: string };
}

function getPgErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Manages clinic bookings using raw SQL queries for exact concurrency control.
 */
@Injectable()
export class BookingsService {
  constructor(private readonly db: DatabaseService) {}

  async findOne(id: string): Promise<BookingDto> {
    const result = await this.db.query<BookingRow>(
      `SELECT id, slot_id, name, email, status, created_at
       FROM bookings
       WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      throw new NotFoundException('booking not found');
    }

    return toBookingDto(result.rows[0]);
  }

  async cancel(id: string): Promise<BookingDto> {
    const updated = await this.db.query<BookingRow>(
      `UPDATE bookings
       SET status = 'cancelled'
       WHERE id = $1 AND status = 'confirmed'
       RETURNING id, slot_id, name, email, status, created_at`,
      [id],
    );

    if (updated.rows.length > 0) {
      return toBookingDto(updated.rows[0]);
    }

    const existing = await this.db.query<{ status: string }>(
      `SELECT status
       FROM bookings
       WHERE id = $1`,
      [id],
    );

    if (existing.rows.length === 0) {
      throw new NotFoundException('booking not found');
    }

    throw new ConflictException('booking already cancelled');
  }

  async list(
    rawEmail: unknown,
    rawLimit: unknown,
    rawCursor: unknown,
  ): Promise<BookingsListResponseDto> {
    if (Array.isArray(rawEmail) || typeof rawEmail !== 'string') {
      throw new BadRequestException('email is required');
    }
    const email = rawEmail.trim().toLowerCase();
    if (email.length === 0) {
      throw new BadRequestException('email is required');
    }

    const limit = this.parsePageLimit(rawLimit);
    const cursorSeq = decodeCursor(rawCursor);

    const params: unknown[] = [email];
    let cursorCondition = '';
    if (cursorSeq !== undefined) {
      params.push(cursorSeq);
      cursorCondition = `AND seq > $${params.length}`;
    }
    params.push(limit + 1);
    const limitParam = `$${params.length}`;

    const result = await this.db.query<BookingWithSeqRow>(
      `SELECT id, slot_id, name, email, status, seq::text AS seq, created_at
       FROM bookings
       WHERE email = $1
         ${cursorCondition}
       ORDER BY seq ASC
       LIMIT ${limitParam}`,
      params,
    );

    const hasMore = result.rows.length > limit;
    const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && lastRow ? encodeCursor(lastRow.seq) : null;

    return {
      bookings: pageRows.map((row) => toBookingDto(row)),
      next_cursor: nextCursor,
    };
  }

  private parsePageLimit(rawLimit: unknown): number {
    if (rawLimit === undefined) {
      return DEFAULT_PAGE_LIMIT;
    }
    if (Array.isArray(rawLimit) || typeof rawLimit !== 'string') {
      throw new BadRequestException('limit must be an integer between 1 and 50');
    }
    const trimmed = rawLimit.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new BadRequestException('limit must be an integer between 1 and 50');
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
      throw new BadRequestException('limit must be an integer between 1 and 50');
    }
    return parsed;
  }

  async create(
    rawBody: unknown,
    rawIdempotencyKey?: string | string[],
  ): Promise<BookingAttemptOutcome> {
    if (Array.isArray(rawIdempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be a single string');
    }
    const idempotencyKey =
      typeof rawIdempotencyKey === 'string' &&
      rawIdempotencyKey.trim().length > 0
        ? rawIdempotencyKey.trim()
        : undefined;

    if (!idempotencyKey) {
      return this.db.withTransaction((client) =>
        this.runCreateAttempt(client, rawBody),
      );
    }

    const bodyHash = hashNormalizedJson(rawBody);

    return this.db.withTransaction(async (client) => {
      // Lock namespace 2 serializes concurrent calls sharing the same Idempotency-Key.
      await client.query('SELECT pg_advisory_xact_lock(2, hashtext($1))', [
        idempotencyKey,
      ]);

      const existingRes = await client.query<{
        body_hash: string;
        status_code: number | null;
        response: BookingDto | { error: string } | null;
      }>(
        `SELECT body_hash, status_code, response
         FROM idempotency_keys
         WHERE key = $1`,
        [idempotencyKey],
      );

      if (existingRes.rows.length > 0) {
        const existing = existingRes.rows[0];
        if (existing.body_hash !== bodyHash) {
          throw new UnprocessableEntityException(
            'idempotency key reused with different request body',
          );
        }
        if (existing.status_code !== null && existing.response !== null) {
          return {
            statusCode: existing.status_code,
            body: existing.response,
          };
        }
      }

      const outcome = await this.runCreateAttempt(client, rawBody);

      // Persist 201, 400, 404, and 409 outcomes; 429 throws RateLimitException and rolls back.
      await client.query(
        `INSERT INTO idempotency_keys (key, body_hash, status_code, response)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (key) DO UPDATE
         SET body_hash = EXCLUDED.body_hash,
             status_code = EXCLUDED.status_code,
             response = EXCLUDED.response`,
        [
          idempotencyKey,
          bodyHash,
          outcome.statusCode,
          JSON.stringify(outcome.body),
        ],
      );

      return outcome;
    });
  }

  private async runCreateAttempt(
    client: PoolClient,
    rawBody: unknown,
  ): Promise<BookingAttemptOutcome> {
    if (
      typeof rawBody !== 'object' ||
      rawBody === null ||
      Array.isArray(rawBody)
    ) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        body: { error: 'request body must be an object' },
      };
    }

    const bodyRecord = rawBody as Record<string, unknown>;
    const emailValidation = this.validateEmailField(bodyRecord.email);
    if (!emailValidation.ok) {
      // Missing or invalid email has nothing to rate-limit against.
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        body: { error: emailValidation.error },
      };
    }
    const email = emailValidation.email;

    // Rate limit before validating other fields or slots so valid-email failures count toward the window.
    await this.enforceRateLimit(client, email);

    const slotValidation = this.validateStringField(
      bodyRecord.slot_id,
      'slot_id',
    );
    if (!slotValidation.ok) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        body: { error: slotValidation.error },
      };
    }

    const nameValidation = this.validateStringField(bodyRecord.name, 'name');
    if (!nameValidation.ok) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        body: { error: nameValidation.error },
      };
    }

    return this.executeBookingInsert(client, {
      slotId: slotValidation.value,
      name: nameValidation.value,
      email,
    });
  }

  private async enforceRateLimit(
    client: PoolClient,
    email: string,
  ): Promise<void> {
    // Lock namespace 1 prevents lock collisions with idempotency keys (namespace 2).
    await client.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [
      email,
    ]);

    const stats = await client.query<{
      attempt_count: string;
      retry_after: number | null;
    }>(
      `SELECT
         COUNT(*)::text AS attempt_count,
         CEIL(EXTRACT(EPOCH FROM (MIN(at) + interval '60 seconds' - now())))::int AS retry_after
       FROM attempts
       WHERE email = $1
         AND at > now() - interval '60 seconds'`,
      [email],
    );

    const count = Number(stats.rows[0]?.attempt_count ?? 0);
    if (count >= MAX_ATTEMPTS_PER_WINDOW) {
      // Blocked requests are not recorded so hammering cannot extend the block window.
      throw new RateLimitException(
        Math.max(1, stats.rows[0]?.retry_after ?? 1),
      );
    }

    await client.query('INSERT INTO attempts (email) VALUES ($1)', [email]);
  }

  private validateEmailField(
    value: unknown,
  ): { ok: true; email: string } | { ok: false; error: string } {
    if (typeof value !== 'string') {
      return {
        ok: false,
        error:
          value === undefined ? 'email is required' : 'email must be a string',
      };
    }
    const email = value.trim().toLowerCase();
    if (email.length === 0) {
      return { ok: false, error: 'email is required' };
    }
    if (!EMAIL_REGEX.test(email)) {
      return { ok: false, error: 'email must be a valid email address' };
    }
    return { ok: true, email };
  }

  private validateStringField(
    value: unknown,
    field: string,
  ): { ok: true; value: string } | { ok: false; error: string } {
    if (typeof value !== 'string') {
      return {
        ok: false,
        error:
          value === undefined
            ? `${field} is required`
            : `${field} must be a string`,
      };
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: `${field} is required` };
    }
    return { ok: true, value: trimmed };
  }

  private async executeBookingInsert(
    client: PoolClient,
    input: { slotId: string; name: string; email: string },
  ): Promise<BookingAttemptOutcome> {
    const slotRes = await client.query<{ is_past: boolean }>(
      `SELECT (start_time <= now()) AS is_past
       FROM slots
       WHERE id = $1`,
      [input.slotId],
    );

    if (slotRes.rows.length === 0) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        body: { error: 'slot not found' },
      };
    }

    if (slotRes.rows[0].is_past) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        body: { error: 'slot has already started' },
      };
    }

    const bookingId = randomUUID();
    // Savepoint keeps the outer transaction (attempts & idempotency_keys) intact on 23505/23503.
    await client.query('SAVEPOINT booking_insert');

    try {
      const insertRes = await client.query<BookingRow>(
        `INSERT INTO bookings (id, slot_id, name, email, status)
         VALUES ($1, $2, $3, $4, 'confirmed')
         RETURNING id, slot_id, name, email, status, created_at`,
        [bookingId, input.slotId, input.name, input.email],
      );

      await client.query('RELEASE SAVEPOINT booking_insert');

      return {
        statusCode: HttpStatus.CREATED,
        body: toBookingDto(insertRes.rows[0]),
      };
    } catch (error) {
      const code = getPgErrorCode(error);

      if (code === '23505') {
        await client.query('ROLLBACK TO SAVEPOINT booking_insert');
        await client.query('RELEASE SAVEPOINT booking_insert');
        return {
          statusCode: HttpStatus.CONFLICT,
          body: { error: 'slot already booked' },
        };
      }

      if (code === '23503') {
        await client.query('ROLLBACK TO SAVEPOINT booking_insert');
        await client.query('RELEASE SAVEPOINT booking_insert');
        return {
          statusCode: HttpStatus.NOT_FOUND,
          body: { error: 'slot not found' },
        };
      }

      throw error;
    }
  }
}
