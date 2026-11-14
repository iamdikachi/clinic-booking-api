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

describe('App (e2e) - Setup, Schema, Auth, Swagger & Level 1', () => {
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
    await db.query('DELETE FROM bookings');
    await db.query('DELETE FROM slots');
    await db.query('DELETE FROM idempotency_keys');
    await db.query('DELETE FROM attempts');
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
      .get('/slots')
      .expect(401)
      .expect({ error: 'unauthorized' });

    await request(app.getHttpServer())
      .post('/reset')
      .send({ slots: [] })
      .expect(401)
      .expect({ error: 'unauthorized' });

    await request(app.getHttpServer())
      .get('/bookings/missing')
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

  it('GET /docs and GET /docs-json expose OpenAPI spec with Level 1 routes', async () => {
    const uiRes = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(uiRes.headers['content-type']).toContain('text/html');
    expect(uiRes.text).toContain('Clinic Booking API Docs');
    expect(uiRes.text).toContain('id="swagger-ui"');

    const jsonRes = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);

    expect(jsonRes.body.info).toMatchObject({
      title: 'Clinic Booking API',
      version: '1.0',
    });
    expect(
      jsonRes.body.components.securitySchemes[API_KEY_SECURITY],
    ).toMatchObject({
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });
    expect(jsonRes.body.components.schemas.ErrorResponseDto).toBeDefined();
    expect(jsonRes.body.paths['/reset']).toBeDefined();
    expect(jsonRes.body.paths['/slots']).toBeDefined();
    expect(jsonRes.body.paths['/bookings/{id}']).toBeDefined();
  });

  it('POST /reset clears all tables and keeps past slots, and GET /slots orders and filters properly', async () => {
    await db.query(
      `INSERT INTO idempotency_keys (key, body_hash, status_code, response)
       VALUES ('old-key', 'hash', 201, '{}'::jsonb)`,
    );
    await db.query(`INSERT INTO attempts (email) VALUES ('old@example.com')`);

    const resetRes = await request(app.getHttpServer())
      .post('/reset')
      .set('X-API-Key', apiKey)
      .send({
        slots: [
          {
            id: 'slot-late',
            provider: 'dr-smith',
            start: '2026-12-10T11:00:00Z',
            end: '2026-12-10T11:30:00Z',
          },
          {
            id: 'slot-past',
            provider: 'dr-smith',
            start: '2020-01-01T09:00:00Z',
            end: '2020-01-01T09:30:00Z',
          },
          {
            id: 'slot-other',
            provider: 'dr-jones',
            start: '2026-12-10T09:00:00Z',
            end: '2026-12-10T09:30:00Z',
          },
        ],
      })
      .expect(200);

    expect(resetRes.body).toEqual({ ok: true, slots_created: 3 });

    const idempCount = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM idempotency_keys',
    );
    const attemptsCount = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM attempts',
    );
    expect(idempCount.rows[0].count).toBe('0');
    expect(attemptsCount.rows[0].count).toBe('0');

    // Insert a cancelled booking on slot-past and a confirmed booking on slot-late
    await db.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ('b-cancelled', 'slot-past', 'Past User', 'past@example.com', 'cancelled'),
              ('b-confirmed', 'slot-late', 'Alice', 'alice@example.com', 'confirmed')`,
    );

    const allSlotsRes = await request(app.getHttpServer())
      .get('/slots')
      .set('X-API-Key', apiKey)
      .expect(200);

    expect(allSlotsRes.body).toEqual({
      slots: [
        {
          id: 'slot-past',
          provider: 'dr-smith',
          start: '2020-01-01T09:00:00Z',
          end: '2020-01-01T09:30:00Z',
          available: true,
        },
        {
          id: 'slot-other',
          provider: 'dr-jones',
          start: '2026-12-10T09:00:00Z',
          end: '2026-12-10T09:30:00Z',
          available: true,
        },
        {
          id: 'slot-late',
          provider: 'dr-smith',
          start: '2026-12-10T11:00:00Z',
          end: '2026-12-10T11:30:00Z',
          available: false,
        },
      ],
    });

    const filteredRes = await request(app.getHttpServer())
      .get('/slots?provider=dr-smith')
      .set('X-API-Key', apiKey)
      .expect(200);

    expect(filteredRes.body.slots).toHaveLength(2);
    expect(filteredRes.body.slots.map((s: { id: string }) => s.id)).toEqual([
      'slot-past',
      'slot-late',
    ]);
  });

  it('GET /bookings/:id returns 200 without seq or 404 when missing', async () => {
    await request(app.getHttpServer())
      .post('/reset')
      .set('X-API-Key', apiKey)
      .send({
        slots: [
          {
            id: 'slot-1',
            provider: 'dr-smith',
            start: '2026-12-10T09:00:00Z',
            end: '2026-12-10T09:30:00Z',
          },
        ],
      })
      .expect(200);

    await db.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ('booking-1', 'slot-1', 'Alice', 'alice@example.com', 'confirmed')`,
    );

    const found = await request(app.getHttpServer())
      .get('/bookings/booking-1')
      .set('X-API-Key', apiKey)
      .expect(200);

    expect(found.body).toEqual({
      id: 'booking-1',
      slot_id: 'slot-1',
      name: 'Alice',
      email: 'alice@example.com',
      status: 'confirmed',
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
    });
    expect(found.body.seq).toBeUndefined();

    const notFound = await request(app.getHttpServer())
      .get('/bookings/does-not-exist')
      .set('X-API-Key', apiKey)
      .expect(404);

    expect(notFound.body).toEqual({ error: 'booking not found' });
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
      .post('/reset')
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
