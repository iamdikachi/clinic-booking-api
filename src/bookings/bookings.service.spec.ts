import { NotFoundException } from '@nestjs/common';
import type { DatabaseService } from '../database/database.service';
import { BookingsService } from './bookings.service';

describe('BookingsService', () => {
  let service: BookingsService;
  let query: jest.Mock;

  beforeEach(() => {
    query = jest.fn();
    service = new BookingsService({ query } as unknown as DatabaseService);
  });

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

    expect(query).toHaveBeenCalledWith(
      expect.not.stringContaining('seq'),
      ['b-1'],
    );
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
    await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
  });
});
