import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type { EnvConfig } from './../src/config/env.validation';
import {
  API_KEY_SECURITY,
  setupSwagger,
} from './../src/config/swagger.config';
import { DatabaseService } from './../src/database/database.service';

describe('App (e2e) - Setup, Schema, Auth & Swagger', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;
  let apiKey: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupSwagger(app);
    await app.init();
    db = app.get(DatabaseService);
    apiKey = app.get(ConfigService<EnvConfig, true>).get('API_KEY', {
      infer: true,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('connects to Postgres via pg pool', async () => {
    await expect(db.ping()).resolves.toBe(true);
  });

  it('ensures Step 2 tables and indexes exist', async () => {
    const tablesRes = await db.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`,
    );
    expect(tablesRes.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        'attempts',
        'bookings',
        'idempotency_keys',
        'slots',
      ]),
    );

    const indexesRes = await db.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'`,
    );
    expect(indexesRes.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'one_confirmed_per_slot',
        'bookings_email_seq',
        'attempts_email_at',
      ]),
    );
  });

  it('enforces one_confirmed_per_slot partial unique index', async () => {
    const slotId = 'e2e-step2-slot';
    await db.query('DELETE FROM slots WHERE id = $1', [slotId]);

    try {
      await db.query(
        `INSERT INTO slots (id, provider, start_time, end_time)
         VALUES ($1, $2, now() + interval '1 hour', now() + interval '2 hour')`,
        [slotId, 'dr-step2'],
      );

      await db.query(
        `INSERT INTO bookings (id, slot_id, name, email, status)
         VALUES ($1, $2, $3, $4, 'confirmed')`,
        ['b-step2-1', slotId, 'Alice', 'alice@example.com'],
      );

      await expect(
        db.query(
          `INSERT INTO bookings (id, slot_id, name, email, status)
           VALUES ($1, $2, $3, $4, 'confirmed')`,
          ['b-step2-2', slotId, 'Bob', 'bob@example.com'],
        ),
      ).rejects.toMatchObject({ code: '23505' });

      await db.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [
        'b-step2-1',
      ]);

      await expect(
        db.query(
          `INSERT INTO bookings (id, slot_id, name, email, status)
           VALUES ($1, $2, $3, $4, 'confirmed')`,
          ['b-step2-3', slotId, 'Bob', 'bob@example.com'],
        ),
      ).resolves.toBeDefined();
    } finally {
      await db.query('DELETE FROM slots WHERE id = $1', [slotId]);
    }
  });

  it('returns 401 {"error":"unauthorized"} when X-API-Key is missing or wrong', async () => {
    await request(app.getHttpServer())
      .get('/')
      .expect(401)
      .expect({ error: 'unauthorized' });

    await request(app.getHttpServer())
      .get('/')
      .set('X-API-Key', 'wrong-key')
      .expect(401)
      .expect({ error: 'unauthorized' });

    await request(app.getHttpServer())
      .get('/does-not-exist')
      .expect(401)
      .expect({ error: 'unauthorized' });
  });

  it('GET / returns 200 with valid X-API-Key', async () => {
    await request(app.getHttpServer())
      .get('/')
      .set('X-API-Key', apiKey)
      .expect(200)
      .expect('Hello World!');
  });

  it('GET /docs serves Swagger UI HTML', async () => {
    const res = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Clinic Booking API Docs');
    expect(res.text).toContain('id="swagger-ui"');
  });

  it('GET /docs-json serves the OpenAPI specification', async () => {
    const res = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);

    expect(res.body.info).toMatchObject({
      title: 'Clinic Booking API',
      version: '1.0',
    });
    expect(res.body.components.securitySchemes[API_KEY_SECURITY]).toMatchObject({
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });
    expect(res.body.components.schemas.ErrorResponseDto).toBeDefined();
    expect(res.body.paths['/']).toBeDefined();
  });

  it('returns {"error": ...} for unknown routes (404) when authenticated', async () => {
    const res = await request(app.getHttpServer())
      .get('/does-not-exist')
      .set('X-API-Key', apiKey)
      .expect(404);

    expect(res.body).toEqual({
      error: expect.any(String),
    });
    expect(Object.keys(res.body)).toEqual(['error']);
  });

  it('returns {"error": ...} for malformed JSON bodies (400) when authenticated', async () => {
    const res = await request(app.getHttpServer())
      .post('/does-not-exist')
      .set('X-API-Key', apiKey)
      .set('Content-Type', 'application/json')
      .send('{"broken": ')
      .expect(400);

    expect(res.body).toEqual({
      error: expect.any(String),
    });
    expect(Object.keys(res.body)).toEqual(['error']);
  });
});
