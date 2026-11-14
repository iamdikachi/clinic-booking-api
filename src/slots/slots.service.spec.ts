import { BadRequestException } from '@nestjs/common';
import type { DatabaseService } from '../database/database.service';
import { SlotsService } from './slots.service';

describe('SlotsService', () => {
  let service: SlotsService;
  let query: jest.Mock;

  beforeEach(() => {
    query = jest.fn();
    service = new SlotsService({ query } as unknown as DatabaseService);
  });

  it('returns slots formatted with UTC ISO timestamps without .000', async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: 'slot-1',
          provider: 'dr-smith',
          start_time: new Date('2026-12-10T09:00:00.000Z'),
          end_time: new Date('2026-12-10T09:30:00.000Z'),
          available: true,
        },
      ],
    });

    const result = await service.findAll(' dr-smith ');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE s.provider = $1'),
      ['dr-smith'],
    );
    expect(result).toEqual({
      slots: [
        {
          id: 'slot-1',
          provider: 'dr-smith',
          start: '2026-12-10T09:00:00Z',
          end: '2026-12-10T09:30:00Z',
          available: true,
        },
      ],
    });
  });

  it('omits WHERE filter when provider is absent or blank', async () => {
    query.mockResolvedValue({ rows: [] });

    await service.findAll(undefined);
    expect(query).toHaveBeenCalledWith(
      expect.not.stringContaining('WHERE s.provider'),
      [],
    );

    query.mockClear();
    await service.findAll('   ');
    expect(query).toHaveBeenCalledWith(
      expect.not.stringContaining('WHERE s.provider'),
      [],
    );
  });

  it('throws BadRequestException when provider is an array', async () => {
    await expect(service.findAll(['a', 'b'])).rejects.toThrow(
      BadRequestException,
    );
  });
});
