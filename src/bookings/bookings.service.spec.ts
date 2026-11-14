import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { RateLimitException } from '../common/exceptions/rate-limit.exception';
import { hashCanonicalJson } from '../common/utils/hash.util';
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
    it('throws RateLimitException with Retry-After when attempts exceed 5 even on invalid email format', async () => {
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_xact_lock
        .mockResolvedValueOnce({ rows: [] }) // insert attempt
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '6', retry_after: 42 }],
        });

      let caught: unknown;
      try {
        await service.create({
          slot_id: '',
          name: '',
          email: '  BAD-EMAIL  ',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RateLimitException);
      expect((caught as RateLimitException).headers['Retry-After']).toBe('42');
      expect(clientQuery).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO attempts (email) VALUES ($1)',
        ['bad-email'],
      );
    });

    it('validates slot_id, name, and email after rate limit check', async () => {
      clientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '1', retry_after: 60 }],
        });

      await expect(
        service.create({
          slot_id: 'slot-1',
          name: 'Alice',
          email: 'not-an-email',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(service.create(null)).rejects.toThrow(BadRequestException);
      await expect(
        service.create({ slot_id: '  ', name: 'Alice', email: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns 404 when slot does not exist and 400 when slot is in the past', async () => {
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // lock
        .mockResolvedValueOnce({ rows: [] }) // attempt
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '1', retry_after: 60 }],
        })
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
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '2', retry_after: 59 }],
        })
        .mockResolvedValueOnce({ rows: [{ is_past: true }] });

      await expect(
        service.create({
          slot_id: 'past-slot',
          name: 'Alice',
          email: 'alice@example.com',
        }),
      ).resolves.toEqual({
        statusCode: 400,
        body: { error: 'slot is in the past' },
      });
    });

    it('throws ConflictException when unique violation 23505 occurs without idempotency key', async () => {
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // lock
        .mockResolvedValueOnce({ rows: [] }) // attempt
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '1', retry_after: 60 }],
        })
        .mockResolvedValueOnce({ rows: [{ is_past: false }] })
        .mockRejectedValueOnce(
          Object.assign(new Error('duplicate'), { code: '23505' }),
        );

      await expect(
        service.create({
          slot_id: 'slot-1',
          name: 'Alice',
          email: 'alice@example.com',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('creates booking and normalizes name and email on 201', async () => {
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // lock
        .mockResolvedValueOnce({ rows: [] }) // attempt
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '1', retry_after: 60 }],
        })
        .mockResolvedValueOnce({ rows: [{ is_past: false }] })
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
        });

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

    it('replays saved idempotent response and rejects mismatched body with 422', async () => {
      const savedBody = {
        id: 'uuid-saved',
        slot_id: 'slot-1',
        name: 'Alice',
        email: 'alice@example.com',
        status: 'confirmed',
        created_at: '2026-12-10T08:00:00Z',
      };
      const expectedHash = hashCanonicalJson({
        slot_id: 'slot-1',
        name: 'Alice',
        email: 'alice@example.com',
      });

      // Replay matching hash
      clientQuery
        .mockResolvedValueOnce({ rows: [] }) // rate limit lock
        .mockResolvedValueOnce({ rows: [] }) // attempt
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '2', retry_after: 59 }],
        })
        .mockResolvedValueOnce({ rows: [] }) // idempotency lock
        .mockResolvedValueOnce({ rows: [] }) // insert ON CONFLICT DO NOTHING -> empty
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
        { email: 'alice@example.com', name: 'Alice', slot_id: 'slot-1' },
        'idem-1',
      );
      expect(replay).toEqual({ statusCode: 201, body: savedBody });

      // Different body -> 422
      clientQuery.mockReset();
      clientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ attempt_count: '3', retry_after: 58 }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
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
  });
});
