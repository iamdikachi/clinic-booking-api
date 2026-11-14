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

describe('App (e2e) - Setup, Schema, Auth, Swagger, Level 1 & Core Booking', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;
  let apiKey: string;

  const futureStart = '2030-12-10T09:00:00Z';
  const futureEnd = '2030-12-10T09:30:00Z';

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
      .post('/bookings')
      .send({ slot_id: 'slot-1', name: 'Alice', email: 'alice@example.com' })
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

  it('GET /docs and GET /docs-json expose OpenAPI spec with all routes', async () => {
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
    expect(jsonRes.body.components.schemas.CreateBookingDto).toBeDefined();
    expect(jsonRes.body.paths['/reset']).toBeDefined();
    expect(jsonRes.body.paths['/slots']).toBeDefined();
    expect(jsonRes.body.paths['/bookings'].post).toBeDefined();
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
  }, 15_000);

  it('GET /bookings/:id returns 200 without seq or 404 when missing', async () => {
    await request(app.getHttpServer())
      .post('/reset')
      .set('X-API-Key', apiKey)
      .send({
        slots: [
          {
            id: 'slot-1',
            provider: 'dr-smith',
            start: futureStart,
            end: futureEnd,
          },
        ],
      })
      .expect(200);

    const created = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({
        slot_id: 'slot-1',
        name: '  Alice  ',
        email: '  ALICE@Example.COM ',
      })
      .expect(201);

    expect(created.body).toEqual({
      id: expect.any(String),
      slot_id: 'slot-1',
      name: 'Alice',
      email: 'alice@example.com',
      status: 'confirmed',
      created_at: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
      ),
    });

    const found = await request(app.getHttpServer())
      .get(`/bookings/${created.body.id}`)
      .set('X-API-Key', apiKey)
      .expect(200);

    expect(found.body).toEqual(created.body);
    expect(found.body.seq).toBeUndefined();

    const notFound = await request(app.getHttpServer())
      .get('/bookings/does-not-exist')
      .set('X-API-Key', apiKey)
      .expect(404);

    expect(notFound.body).toEqual({ error: 'booking not found' });
  }, 15_000);

  it('POST /bookings validates inputs (400) and slot availability/time (404 / 400)', async () => {
    await request(app.getHttpServer())
      .post('/reset')
      .set('X-API-Key', apiKey)
      .send({
        slots: [
          {
            id: 'slot-past',
            provider: 'dr-smith',
            start: '2020-01-01T09:00:00Z',
            end: '2020-01-01T09:30:00Z',
          },
        ],
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({ slot_id: '   ', name: 'Alice', email: 'val@example.com' })
      .expect(400)
      .expect({ error: 'slot_id is required' });

    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({ slot_id: 'slot-past', name: '  ', email: 'val@example.com' })
      .expect(400)
      .expect({ error: 'name is required' });

    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({ slot_id: 'slot-past', name: 'Alice', email: 'bad-email' })
      .expect(400)
      .expect({ error: 'email must be a valid email address' });

    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({ slot_id: 'no-such-slot', name: 'Alice', email: 'a@example.com' })
      .expect(404)
      .expect({ error: 'slot not found' });

    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({ slot_id: 'slot-past', name: 'Alice', email: 'b@example.com' })
      .expect(400)
      .expect({ error: 'slot is in the past' });
  }, 15_000);

  it('POST /bookings allows exactly 1 winner out of 20 parallel requests (1x 201, 19x 409)', async () => {
    await request(app.getHttpServer())
      .post('/reset')
      .set('X-API-Key', apiKey)
      .send({
        slots: [
          {
            id: 'race-slot',
            provider: 'dr-smith',
            start: futureStart,
            end: futureEnd,
          },
        ],
      })
      .expect(200);

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request(app.getHttpServer())
          .post('/bookings')
          .set('X-API-Key', apiKey)
          .send({
            slot_id: 'race-slot',
            name: `User ${i}`,
            email: `user${i}@example.com`,
          }),
      ),
    );

    const created = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(19);
    for (const conflict of conflicts) {
      expect(conflict.body).toEqual({ error: 'slot already booked' });
    }
  }, 20_000);

  it('POST /bookings supports Idempotency-Key replay (including 4xx and parallel retries) and 422 on body mismatch', async () => {
    await request(app.getHttpServer())
      .post('/reset')
      .set('X-API-Key', apiKey)
      .send({
        slots: [
          {
            id: 'idem-slot',
            provider: 'dr-smith',
            start: futureStart,
            end: futureEnd,
          },
        ],
      })
      .expect(200);

    const [r1, r2] = await Promise.all([
      request(app.getHttpServer())
        .post('/bookings')
        .set('X-API-Key', apiKey)
        .set('Idempotency-Key', 'key-success')
        .send({
          slot_id: 'idem-slot',
          name: 'Alice',
          email: 'alice-idem@example.com',
        }),
      request(app.getHttpServer())
        .post('/bookings')
        .set('X-API-Key', apiKey)
        .set('Idempotency-Key', 'key-success')
        .send({
          email: 'alice-idem@example.com',
          name: 'Alice',
          slot_id: 'idem-slot',
        }),
    ]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual(r1.body);

    // Mismatched body with same key -> 422
    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .set('Idempotency-Key', 'key-success')
      .send({
        slot_id: 'idem-slot',
        name: 'Different Name',
        email: 'alice-idem@example.com',
      })
      .expect(422)
      .expect({ error: 'idempotency key reused with different request body' });

    // Replays 409 identically even if slot were checked again
    const err1 = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .set('Idempotency-Key', 'key-409')
      .send({
        slot_id: 'idem-slot',
        name: 'Bob',
        email: 'bob-idem@example.com',
      })
      .expect(409);

    const err2 = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .set('Idempotency-Key', 'key-409')
      .send({
        slot_id: 'idem-slot',
        name: 'Bob',
        email: 'bob-idem@example.com',
      })
      .expect(409);

    expect(err2.body).toEqual(err1.body);
  }, 15_000);

  it('POST /bookings enforces per-email rate limit (5/60s), counts failures & retries, sets Retry-After, and isolates other emails', async () => {
    await request(app.getHttpServer())
      .post('/reset')
      .set('X-API-Key', apiKey)
      .send({
        slots: [
          {
            id: 'rl-slot',
            provider: 'dr-smith',
            start: futureStart,
            end: futureEnd,
          },
        ],
      })
      .expect(200);

    // 5 parallel attempts for same email (1x 201 + 4x 409, none 429)
    const burst = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app.getHttpServer())
          .post('/bookings')
          .set('X-API-Key', apiKey)
          .set('Idempotency-Key', 'rl-same-key')
          .send({
            slot_id: 'rl-slot',
            name: 'Same User',
            email: '  RATE@Example.COM ',
          }),
      ),
    );

    expect(burst.every((r) => r.status === 201)).toBe(true);

    // 6th attempt (even a replay with same Idempotency-Key) hits 429 with Retry-After >= 1
    const sixth = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .set('Idempotency-Key', 'rl-same-key')
      .send({
        slot_id: 'rl-slot',
        name: 'Same User',
        email: 'rate@example.com',
      })
      .expect(429);

    expect(sixth.body).toEqual({ error: 'rate limit exceeded' });
    const retryAfter = Number(sixth.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // Different email is unaffected (gets 409 for already booked slot, not 429)
    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({
        slot_id: 'rl-slot',
        name: 'Other User',
        email: 'other@example.com',
      })
      .expect(409);
  }, 15_000);

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
