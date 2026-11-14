import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../database/database.service';
import { ResetService } from './reset.service';

describe('ResetService', () => {
  let service: ResetService;
  let clientQuery: jest.Mock;
  let withTransaction: jest.Mock;

  beforeEach(() => {
    clientQuery = jest.fn().mockResolvedValue({ rows: [] });
    withTransaction = jest.fn(
      async (fn: (client: PoolClient) => Promise<unknown>) =>
        fn({ query: clientQuery } as unknown as PoolClient),
    );
    const db = { withTransaction } as unknown as DatabaseService;
    service = new ResetService(db);
  });

  it('clears all tables and inserts all slots including past slots in one transaction', async () => {
    const result = await service.reset({
      slots: [
        {
          id: 'past-1',
          provider: 'dr-smith',
          start: '2020-01-01T09:00:00Z',
          end: '2020-01-01T09:30:00Z',
        },
        {
          id: 'future-1',
          provider: 'dr-jones',
          start: '2027-01-01T10:00:00Z',
          end: '2027-01-01T10:30:00Z',
        },
      ],
    });

    expect(result).toEqual({ ok: true, slots_created: 2 });
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(clientQuery).toHaveBeenNthCalledWith(1, 'DELETE FROM bookings');
    expect(clientQuery).toHaveBeenNthCalledWith(2, 'DELETE FROM slots');
    expect(clientQuery).toHaveBeenNthCalledWith(
      3,
      'DELETE FROM idempotency_keys',
    );
    expect(clientQuery).toHaveBeenNthCalledWith(4, 'DELETE FROM attempts');
    expect(clientQuery).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('INSERT INTO slots'),
      [
        ['past-1', 'future-1'],
        ['dr-smith', 'dr-jones'],
        ['2020-01-01T09:00:00.000Z', '2027-01-01T10:00:00.000Z'],
        ['2020-01-01T09:30:00.000Z', '2027-01-01T10:30:00.000Z'],
      ],
    );
  });

  it('clears tables without inserting when slots array is empty or omitted', async () => {
    await expect(service.reset({ slots: [] })).resolves.toEqual({
      ok: true,
      slots_created: 0,
    });
    expect(clientQuery).toHaveBeenCalledTimes(4);

    clientQuery.mockClear();
    await expect(service.reset(undefined)).resolves.toEqual({
      ok: true,
      slots_created: 0,
    });
    expect(clientQuery).toHaveBeenCalledTimes(4);
  });

  it('rejects invalid payloads and duplicate slot IDs', async () => {
    await expect(service.reset([])).rejects.toThrow(BadRequestException);
    await expect(service.reset({ slots: 'bad' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.reset({
        slots: [
          {
            id: 's1',
            provider: 'dr-a',
            start: '2026-12-10T09:00:00Z',
            end: '2026-12-10T09:30:00Z',
          },
          {
            id: 's1',
            provider: 'dr-b',
            start: '2026-12-10T10:00:00Z',
            end: '2026-12-10T10:30:00Z',
          },
        ],
      }),
    ).rejects.toThrow('duplicate slot id: s1');
    await expect(
      service.reset({
        slots: [
          {
            id: 's1',
            provider: 'dr-a',
            start: 'not-a-date',
            end: '2026-12-10T09:30:00Z',
          },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
