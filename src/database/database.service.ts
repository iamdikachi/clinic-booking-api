import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';
import type { EnvConfig } from '../config/env.validation';
import { SCHEMA_SQL } from './schema';

/**
 * Upgrades `sslmode=require` to `sslmode=verify-full` (when libpq compat is not
 * requested) to match pg's current strict TLS behavior without startup warnings.
 */
function normalizeDatabaseUrl(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    if (
      parsed.searchParams.get('sslmode') === 'require' &&
      !parsed.searchParams.has('uselibpqcompat')
    ) {
      parsed.searchParams.set('sslmode', 'verify-full');
    }
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

function isTransientConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  if (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === '57P01'
  ) {
    return true;
  }
  const msg = typeof candidate.message === 'string' ? candidate.message : '';
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('Connection terminated unexpectedly')
  );
}

/**
 * Raw SQL Postgres client wrapper backed by a `pg` connection pool.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor(private readonly configService: ConfigService<EnvConfig, true>) {
    const rawUrl = this.configService.get('DATABASE_URL', { infer: true });
    this.pool = new Pool({
      connectionString: normalizeDatabaseUrl(rawUrl),
      max: 20,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });

    this.pool.on('error', (err) => {
      if (isTransientConnectionError(err)) {
        this.logger.warn(
          `Idle Postgres connection reset (${err.message}); pool will open a fresh connection on demand`,
        );
        return;
      }
      this.logger.error('Unexpected Postgres pool error', err.stack);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.pool.query('SELECT 1');
    } catch (error) {
      if (!isTransientConnectionError(error)) {
        throw error;
      }
      await this.pool.query('SELECT 1');
    }
    await this.ensureSchema();
    this.logger.log('Connected to Postgres and verified schema');
  }

  /**
   * Ensures tables and indexes exist using an advisory lock to avoid concurrent DDL races.
   */
  async ensureSchema(): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('clinic_api_schema_init'))",
      );
      await client.query(SCHEMA_SQL);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.openTransactionClient();
    let discardClient = false;

    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (isTransientConnectionError(error)) {
        discardClient = true;
      } else {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          discardClient = true;
          this.logger.error(
            'Failed to rollback Postgres transaction',
            rollbackError instanceof Error ? rollbackError.stack : undefined,
          );
        }
      }
      throw error;
    } finally {
      client.release(discardClient);
    }
  }

  private async openTransactionClient(): Promise<PoolClient> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        return client;
      } catch (error) {
        client.release(true);
        if (attempt === 0 && isTransientConnectionError(error)) {
          continue;
        }
        throw error;
      }
    }
    throw new Error('Failed to open Postgres transaction');
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
