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
import { hashCanonicalJson } from '../common/utils/hash.util';
import { DatabaseService } from '../database/database.service';
import {
  type BookingDto,
  type BookingRow,
  toBookingDto,
} from './dto/booking.dto';

const MAX_ATTEMPTS_PER_WINDOW = 5;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_IDEMPOTENCY_POLLS = 10;
const IDEMPOTENCY_POLL_DELAY_MS = 50;

interface ValidatedCreateInput {
  slotId: string;
  name: string;
  email: string;
}

export interface BookingAttemptOutcome {
  statusCode: number;
  body: BookingDto | { error: string };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  async create(
    rawBody: unknown,
    rawIdempotencyKey?: string | string[],
  ): Promise<BookingAttemptOutcome> {
    if (
      typeof rawBody !== 'object' ||
      rawBody === null ||
      Array.isArray(rawBody)
    ) {
      throw new BadRequestException('request body must be an object');
    }

    const bodyRecord = rawBody as Record<string, unknown>;

    // Rate limit first (failed attempts and idempotent retries count too).
    if (typeof bodyRecord.email === 'string') {
      const rateLimitEmail = bodyRecord.email.trim().toLowerCase();
      if (rateLimitEmail.length > 0) {
        await this.enforceRateLimit(rateLimitEmail);
      }
    }

    // Validate payload fields and normalize email/name.
    const input = this.validateCreateInput(bodyRecord);

    if (Array.isArray(rawIdempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be a single string');
    }
    const idempotencyKey =
      typeof rawIdempotencyKey === 'string' &&
      rawIdempotencyKey.trim().length > 0
        ? rawIdempotencyKey.trim()
        : undefined;

    // Idempotency, slot checks, booking insert, and saving idempotent responses.
    if (!idempotencyKey) {
      return this.db.withTransaction((client) =>
        this.executeBookingAttempt(client, input, false),
      );
    }

    const bodyHash = hashCanonicalJson({
      ...bodyRecord,
      slot_id: input.slotId,
      name: input.name,
      email: input.email,
    });

    return this.executeIdempotentBooking(idempotencyKey, bodyHash, input);
  }

  private async enforceRateLimit(email: string): Promise<void> {
    const retryAfter = await this.db.withTransaction(async (client) => {
      // Lock namespace 1 prevents lock collisions with idempotency keys (namespace 2).
      await client.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [
        email,
      ]);
      await client.query('INSERT INTO attempts (email) VALUES ($1)', [email]);

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
      if (count > MAX_ATTEMPTS_PER_WINDOW) {
        return Math.max(1, stats.rows[0]?.retry_after ?? 1);
      }
      return null;
    });

    if (retryAfter !== null) {
      throw new RateLimitException(retryAfter);
    }
  }

  private validateCreateInput(
    body: Record<string, unknown>,
  ): ValidatedCreateInput {
    const slotId = this.requireTrimmedString(body.slot_id, 'slot_id');
    const name = this.requireTrimmedString(body.name, 'name');
    const email = this.requireTrimmedString(body.email, 'email').toLowerCase();

    if (!EMAIL_REGEX.test(email)) {
      throw new BadRequestException('email must be a valid email address');
    }

    return { slotId, name, email };
  }

  private requireTrimmedString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(`${field} is required`);
    }
    return value.trim();
  }

  private async executeIdempotentBooking(
    key: string,
    bodyHash: string,
    input: ValidatedCreateInput,
  ): Promise<BookingAttemptOutcome> {
    for (let poll = 0; poll < MAX_IDEMPOTENCY_POLLS; poll++) {
      const outcome = await this.db.withTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(2, hashtext($1))', [
          key,
        ]);

        const claimRes = await client.query<{ key: string }>(
          `INSERT INTO idempotency_keys (key, body_hash)
           VALUES ($1, $2)
           ON CONFLICT (key) DO NOTHING
           RETURNING key`,
          [key, bodyHash],
        );

        if (claimRes.rows.length > 0) {
          const result = await this.executeBookingAttempt(client, input, true);
          await client.query(
            `UPDATE idempotency_keys
             SET status_code = $2, response = $3::jsonb
             WHERE key = $1`,
            [key, result.statusCode, JSON.stringify(result.body)],
          );
          return { state: 'done' as const, result };
        }

        const existingRes = await client.query<{
          body_hash: string;
          status_code: number | null;
          response: BookingDto | { error: string } | null;
        }>(
          `SELECT body_hash, status_code, response
           FROM idempotency_keys
           WHERE key = $1`,
          [key],
        );

        const existing = existingRes.rows[0];
        if (!existing) {
          return { state: 'pending' as const };
        }

        if (existing.body_hash !== bodyHash) {
          throw new UnprocessableEntityException(
            'idempotency key reused with different request body',
          );
        }

        if (existing.status_code !== null && existing.response !== null) {
          return {
            state: 'done' as const,
            result: {
              statusCode: existing.status_code,
              body: existing.response,
            },
          };
        }

        return { state: 'pending' as const };
      });

      if (outcome.state === 'done') {
        return outcome.result;
      }

      await delay(IDEMPOTENCY_POLL_DELAY_MS);
    }

    throw new ConflictException(
      'request with this idempotency key is still in progress',
    );
  }

  private async executeBookingAttempt(
    client: PoolClient,
    input: ValidatedCreateInput,
    useSavepoint: boolean,
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
        body: { error: 'slot is in the past' },
      };
    }

    const bookingId = randomUUID();
    if (useSavepoint) {
      // Savepoint keeps the outer idempotency transaction alive if the unique index rejects the insert.
      await client.query('SAVEPOINT booking_insert');
    }

    try {
      const insertRes = await client.query<BookingRow>(
        `INSERT INTO bookings (id, slot_id, name, email, status)
         VALUES ($1, $2, $3, $4, 'confirmed')
         RETURNING id, slot_id, name, email, status, created_at`,
        [bookingId, input.slotId, input.name, input.email],
      );

      if (useSavepoint) {
        await client.query('RELEASE SAVEPOINT booking_insert');
      }

      return {
        statusCode: HttpStatus.CREATED,
        body: toBookingDto(insertRes.rows[0]),
      };
    } catch (error) {
      const code = getPgErrorCode(error);

      if (code === '23505') {
        if (!useSavepoint) {
          throw new ConflictException('slot already booked');
        }
        await client.query('ROLLBACK TO SAVEPOINT booking_insert');
        await client.query('RELEASE SAVEPOINT booking_insert');
        return {
          statusCode: HttpStatus.CONFLICT,
          body: { error: 'slot already booked' },
        };
      }

      if (code === '23503') {
        if (!useSavepoint) {
          throw new NotFoundException('slot not found');
        }
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
