export interface EnvConfig {
  PORT: number;
  DATABASE_URL: string;
  API_KEY: string;
}

/**
 * Validates required environment variables on application startup.
 */
export function validateEnv(
  config: Record<string, unknown>,
): EnvConfig & Record<string, unknown> {
  const rawDatabaseUrl = config.DATABASE_URL;
  if (
    typeof rawDatabaseUrl !== 'string' ||
    rawDatabaseUrl.trim().length === 0
  ) {
    throw new Error('Environment variable DATABASE_URL is required');
  }

  const databaseUrl = rawDatabaseUrl.trim();
  if (
    !databaseUrl.startsWith('postgres://') &&
    !databaseUrl.startsWith('postgresql://')
  ) {
    throw new Error(
      'Environment variable DATABASE_URL must be a Postgres connection string',
    );
  }

  const rawApiKey = config.API_KEY;
  if (typeof rawApiKey !== 'string' || rawApiKey.trim().length === 0) {
    throw new Error('Environment variable API_KEY is required');
  }

  const rawPort = config.PORT;
  let port = 3000;
  if (rawPort !== undefined && rawPort !== null) {
    if (typeof rawPort === 'number') {
      port = rawPort;
    } else if (typeof rawPort === 'string') {
      const trimmedPort = rawPort.trim();
      if (trimmedPort !== '') {
        port = Number(trimmedPort);
      }
    } else {
      port = Number.NaN;
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        'Environment variable PORT must be an integer between 1 and 65535',
      );
    }
  }

  return {
    ...config,
    PORT: port,
    DATABASE_URL: databaseUrl,
    API_KEY: rawApiKey.trim(),
  };
}
