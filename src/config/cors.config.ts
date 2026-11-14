import { type INestApplication } from '@nestjs/common';

/**
 * Enables CORS for separate-origin browser clients using X-API-Key and Idempotency-Key.
 */
export function setupCors(app: INestApplication): void {
  app.enableCors({
    origin: '*',
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Idempotency-Key'],
    exposedHeaders: ['Retry-After'],
  });
}
