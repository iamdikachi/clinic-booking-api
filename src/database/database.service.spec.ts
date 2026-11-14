import { type ConfigService } from '@nestjs/config';
import { type PoolClient } from 'pg';
import type { EnvConfig } from '../config/env.validation';
import { DatabaseService } from './database.service';

describe('DatabaseService', () => {
  let service: DatabaseService;

  beforeEach(() => {
    const configService = {
      get: jest
        .fn()
        .mockReturnValue('postgresql://user:pass@localhost:5432/clinic?sslmode=require'),
    } as unknown as ConfigService<EnvConfig, true>;

    service = new DatabaseService(configService);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('retries once when an idle pooled socket resets before BEGIN', async () => {
    const staleRelease = jest.fn();
    const staleClient = {
      query: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        ),
      release: staleRelease,
    } as unknown as PoolClient;

    const freshQuery = jest.fn().mockResolvedValue({ rows: [] });
    const freshRelease = jest.fn();
    const freshClient = {
      query: freshQuery,
      release: freshRelease,
    } as unknown as PoolClient;

    const pool = (service as unknown as { pool: { connect: jest.Mock } }).pool;
    pool.connect = jest
      .fn()
      .mockResolvedValueOnce(staleClient)
      .mockResolvedValueOnce(freshClient);

    const result = await service.withTransaction(async () => 'ok');

    expect(result).toBe('ok');
    expect(staleRelease).toHaveBeenCalledWith(true);
    expect(freshQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(freshQuery).toHaveBeenNthCalledWith(2, 'COMMIT');
    expect(freshRelease).toHaveBeenCalledWith(false);
  });
});
