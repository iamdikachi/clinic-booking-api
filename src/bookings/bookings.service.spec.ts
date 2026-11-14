import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { RateLimitException } from '../common/exceptions/rate-limit.exception';
import { hashNormalizedJson } from '../common/utils/hash.util';
import type { DatabaseService } from '../database/database.service';
import { BookingsService } from './bookings.service';

describe('BookingsService', () => {
  let service: BookingsService;
  let query: jest.Mock;
  let withTransaction: jest.Mock;
  let clientQuery: jest.Mock;

  beforeEach(() => {
    query = jest.fn();
    clientQuery = jest.fn();
    withTransaction = jest.fn(
      async (fn: (client: PoolClient) => Promise<unknown>) =>
        fn({ query: clientQuery } as unknown as PoolClient),
    );
    service = new BookingsService({
      query,
      withTransaction,
    } as unknown as DatabaseService);
  });

  describe('findOne', () => {
    it('returns the booking without seq when found', async () => {
      query.mockResolvedValue({
        rows: [
          {
            id: 'b-1',
            slot_id: 'slot-1',
            name: 'Alice',
            email: 'alice@example.com',
            status: 'confirmed',
            created_at: new Date('2026-12-10T08:00:00.000Z'),
          },
        ],
      });

      const booking = await service.findOne('b-1');

      expect(query).toHaveBeenCalledWith(expect.not.stringContaining('seq'), [
        'b-1',
      ]);
      expect(booking).toEqual({
        id: 'b-1',
        slot_id: 'slot-1',
        name: 'Alice',
        email: 'alice@example.com',
        status: 'confirmed',
        created_at: '2026-12-10T08:00:00Z',
      });
    });

    it('throws NotFoundException when booking does not exist', async () => {
      query.mockResolvedValue({ rows: [] });
      await expect(service.findOne('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('counts attempts before inserting and throws 429 without recording blocked requests', async () => {
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_xact_lock(1, ...)
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '5', retry_after: 42 }],
        });

      let caught: unknown;
      try {
        await service.create({
          slot_id: 'slot-1',
          name: 'Alice',
          email: '  ALICE@Example.COM  ',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RateLimitException);
      expect((caught as RateLimitException).headers['Retry-After']).toBe('42');
      // Only lock + count ran; INSERT INTO attempts must NOT be called when >= 5.
      expect(clientQuery).toHaveBeenCalledTimes(2);
      expect(clientQuery).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO attempts'),
        expect.anything(),
      );
    });

    it('returns 400 without touching attempts when email is missing, non-string, or malformed', async () => {
      await expect(service.create(null)).resolves.toEqual({
        statusCode: 400,
        body: { error: 'request body must be an object' },
      });
      await expect(
        service.create({ slot_id: 'slot-1', name: 'Alice', email: 123 }),
      ).resolves.toEqual({
        statusCode: 400,
        body: { error: 'email must be a string' },
      });
      await expect(
        service.create({ slot_id: 'slot-1', name: 'Alice', email: '   ' }),
      ).resolves.toEqual({
        statusCode: 400,
        body: { error: 'email is required' },
      });
      await expect(
        service.create({
          slot_id: 'slot-1',
          name: 'Alice',
          email: 'not-an-email',
        }),
      ).resolves.toEqual({
        statusCode: 400,
        body: { error: 'email must be a valid email address' },
      });

      expect(clientQuery).not.toHaveBeenCalled();
    });

    it('records rate-limit attempt before validating slot_id/name types and blank values', async () => {
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // lock
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '0', retry_after: null }],
        })
        .mockResolvedValueOnce({ rows: [] }); // INSERT INTO attempts

      await expect(
        service.create({
          slot_id: 123,
          name: 'Alice',
          email: 'alice@example.com',
        }),
      ).resolves.toEqual({
        statusCode: 400,
        body: { error: 'slot_id must be a string' },
      });

      expect(clientQuery).toHaveBeenNthCalledWith(
        3,
        'INSERT INTO attempts (email) VALUES ($1)',
        ['alice@example.com'],
      );

      clientQuery.mockReset();
      clientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '1', retry_after: 59 }],
        })
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        service.create({
          slot_id: 'slot-1',
          name: true,
          email: 'alice@example.com',
        }),
      ).resolves.toEqual({
        statusCode: 400,
        body: { error: 'name must be a string' },
      });
    });

    it('returns 404 when slot does not exist and 400 when slot has already started', async () => {
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // lock
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '0', retry_after: null }],
        })
        .mockResolvedValueOnce({ rows: [] }) // insert attempt
        .mockResolvedValueOnce({ rows: [] }); // slot lookup

      await expect(
        service.create({
          slot_id: 'missing',
          name: 'Alice',
          email: 'alice@example.com',
        }),
      ).resolves.toEqual({
        statusCode: 404,
        body: { error: 'slot not found' },
      });

      clientQuery.mockReset();
      clientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '1', retry_after: 59 }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ is_past: true }] });

      await expect(
        service.create({
          slot_id: 'past-slot',
          name: 'Alice',
          email: 'alice@example.com',
        }),
      ).resolves.toEqual({
        statusCode: 400,
        body: { error: 'slot has already started' },
      });
    });

    it('rolls back to savepoint and returns 409 when unique violation 23505 occurs', async () => {
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // lock
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '0', retry_after: null }],
        })
        .mockResolvedValueOnce({ rows: [] }) // insert attempt
        .mockResolvedValueOnce({ rows: [{ is_past: false }] }) // slot lookup
        .mockResolvedValueOnce({ rows: [] }) // SAVEPOINT
        .mockRejectedValueOnce(
          Object.assign(new Error('duplicate'), { code: '23505' }),
        )
        .mockResolvedValueOnce({ rows: [] }) // ROLLBACK TO SAVEPOINT
        .mockResolvedValueOnce({ rows: [] }); // RELEASE SAVEPOINT

      await expect(
        service.create({
          slot_id: 'slot-1',
          name: 'Alice',
          email: 'alice@example.com',
        }),
      ).resolves.toEqual({
        statusCode: 409,
        body: { error: 'slot already booked' },
      });
    });

    it('creates booking and normalizes name and email on 201', async () => {
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // lock
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '0', retry_after: null }],
        })
        .mockResolvedValueOnce({ rows: [] }) // insert attempt
        .mockResolvedValueOnce({ rows: [{ is_past: false }] }) // slot lookup
        .mockResolvedValueOnce({ rows: [] }) // SAVEPOINT
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'uuid-1',
              slot_id: 'slot-1',
              name: 'Alice',
              email: 'alice@example.com',
              status: 'confirmed',
              created_at: new Date('2026-12-10T08:00:00.000Z'),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }); // RELEASE SAVEPOINT

      const res = await service.create({
        slot_id: ' slot-1 ',
        name: '  Alice  ',
        email: '  ALICE@Example.COM ',
      });

      expect(res).toEqual({
        statusCode: 201,
        body: {
          id: 'uuid-1',
          slot_id: 'slot-1',
          name: 'Alice',
          email: 'alice@example.com',
          status: 'confirmed',
          created_at: '2026-12-10T08:00:00Z',
        },
      });
    });

    it('checks idempotency replay before rate limit, compares trimmed lowercased body, and throws 422 on mismatch', async () => {
      const savedBody = {
        id: 'uuid-saved',
        slot_id: 'slot-1',
        name: 'Alice',
        email: 'alice@example.com',
        status: 'confirmed',
        created_at: '2026-12-10T08:00:00Z',
      };
      const expectedHash = hashNormalizedJson({
        slot_id: 'slot-1',
        name: 'Alice',
        email: 'alice@example.com',
      });

      // Replay matching normalized hash (even with different case/whitespace/key order) without rate limit queries
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // idempotency lock(2, ...)
        .mockResolvedValueOnce({
          rows: [
            {
              body_hash: expectedHash,
              status_code: 201,
              response: savedBody,
            },
          ],
        });

      const replay = await service.create(
        {
          email: '  ALICE@Example.com ',
          name: ' alice ',
          slot_id: ' SLOT-1 ',
        },
        'idem-1',
      );
      expect(replay).toEqual({ statusCode: 201, body: savedBody });
      expect(clientQuery).toHaveBeenCalledTimes(2);

      // Different body -> 422
      clientQuery.mockReset();
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // lock
        .mockResolvedValueOnce({
          rows: [
            {
              body_hash: expectedHash,
              status_code: 201,
              response: savedBody,
            },
          ],
        });

      await expect(
        service.create(
          { slot_id: 'slot-1', name: 'Bob', email: 'alice@example.com' },
          'idem-1',
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('persists 400 responses in idempotency_keys and never caches 429', async () => {
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // lock(2, key)
        .mockResolvedValueOnce({ rows: [] }) // SELECT idempotency_keys -> empty
        .mockResolvedValueOnce({ rows: [] }) // lock(1, email)
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '0', retry_after: null }],
        })
        .mockResolvedValueOnce({ rows: [] }) // INSERT INTO attempts
        .mockResolvedValueOnce({ rows: [] }); // INSERT INTO idempotency_keys

      const badRes = await service.create(
        { slot_id: '', name: 'Alice', email: 'alice@example.com' },
        'idem-400',
      );
      expect(badRes).toEqual({
        statusCode: 400,
        body: { error: 'slot_id is required' },
      });
      expect(clientQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('INSERT INTO idempotency_keys'),
        ['idem-400', expect.any(String), 400, JSON.stringify(badRes.body)],
      );

      // Rate-limited request must throw 429 without touching idempotency_keys insert
      clientQuery.mockReset();
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // lock(2, key)
        .mockResolvedValueOnce({ rows: [] }) // SELECT idempotency_keys -> empty
        .mockResolvedValueOnce({ rows: [] }) // lock(1, email)
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '5', retry_after: 30 }],
        });

      await expect(
        service.create(
          { slot_id: 'slot-1', name: 'Alice', email: 'alice@example.com' },
          'idem-429',
        ),
      ).rejects.toThrow(RateLimitException);
      expect(clientQuery).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO idempotency_keys'),
        expect.anything(),
      );
    });
  });

  describe('cancel', () => {
    it('returns cancelled booking when confirmed booking exists', async () => {
      query.mockResolvedValueOnce({
        rows: [
          {
            id: 'b-1',
            slot_id: 'slot-1',
            name: 'Alice',
            email: 'alice@example.com',
            status: 'cancelled',
            created_at: new Date('2026-12-10T08:00:00.000Z'),
          },
        ],
      });

      const res = await service.cancel('b-1');
      expect(res).toEqual({
        id: 'b-1',
        slot_id: 'slot-1',
        name: 'Alice',
        email: 'alice@example.com',
        status: 'cancelled',
        created_at: '2026-12-10T08:00:00Z',
      });
    });

    it('throws NotFoundException when booking does not exist', async () => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await expect(service.cancel('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException when booking is already cancelled', async () => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ status: 'cancelled' }] });

      await expect(service.cancel('b-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('list', () => {
    it('validates required email, limit (1..50), and cursor', async () => {
      await expect(
        service.list(undefined, undefined, undefined),
      ).rejects.toThrow(BadRequestException);
      await expect(service.list('   ', undefined, undefined)).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.list('a@b.com', '0', undefined),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.list('a@b.com', '51', undefined),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.list('a@b.com', '1.5', undefined),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.list('a@b.com', '10', 'not-valid-cursor!'),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns paginated bookings without seq and encodes next_cursor when extra row exists', async () => {
      query.mockResolvedValueOnce({
        rows: [
          {
            id: 'b-1',
            slot_id: 's-1',
            name: 'Alice',
            email: 'alice@example.com',
            status: 'confirmed',
            seq: '10',
            created_at: new Date('2026-12-10T08:00:00.000Z'),
          },
          {
            id: 'b-2',
            slot_id: 's-2',
            name: 'Alice',
            email: 'alice@example.com',
            status: 'confirmed',
            seq: '11',
            created_at: new Date('2026-12-10T08:01:00.000Z'),
          },
          {
            id: 'b-3',
            slot_id: 's-3',
            name: 'Alice',
            email: 'alice@example.com',
            status: 'confirmed',
            seq: '12',
            created_at: new Date('2026-12-10T08:02:00.000Z'),
          },
        ],
      });

      const page1 = await service.list(' ALICE@Example.COM ', '2', undefined);

      expect(query).toHaveBeenCalledWith(expect.any(String), [
        'alice@example.com',
        3,
      ]);
      expect(page1.bookings).toHaveLength(2);
      expect(page1.bookings[0]).not.toHaveProperty('seq');
      expect(page1.next_cursor).toBe(
        Buffer.from('11', 'utf8').toString('base64url'),
      );

      // Next page with decoded cursor and no extra row -> next_cursor: null
      query.mockResolvedValueOnce({
        rows: [
          {
            id: 'b-3',
            slot_id: 's-3',
            name: 'Alice',
            email: 'alice@example.com',
            status: 'confirmed',
            seq: '12',
            created_at: new Date('2026-12-10T08:02:00.000Z'),
          },
        ],
      });

      const page2 = await service.list(
        'alice@example.com',
        undefined,
        page1.next_cursor ?? undefined,
      );

      expect(query).toHaveBeenLastCalledWith(expect.any(String), [
        'alice@example.com',
        '11',
        11,
      ]);
      expect(page2.bookings).toHaveLength(1);
      expect(page2.next_cursor).toBeNull();
    });
  });
});
