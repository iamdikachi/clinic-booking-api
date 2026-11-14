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
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM bookings');
      await db.query('DELETE FROM slots');
      await db.query('DELETE FROM idempotency_keys');
      await db.query('DELETE FROM attempts');
    }
    if (app) {
      await app.close();
    }
  }, 15_000);

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
    expect(jsonRes.body.components.schemas.BookingsListResponseDto).toBeDefined();
    expect(jsonRes.body.paths['/reset']).toBeDefined();
    expect(jsonRes.body.paths['/slots']).toBeDefined();
    expect(jsonRes.body.paths['/bookings'].post).toBeDefined();
    expect(jsonRes.body.paths['/bookings'].get).toBeDefined();
    expect(jsonRes.body.paths['/bookings/{id}'].get).toBeDefined();
    expect(jsonRes.body.paths['/bookings/{id}'].delete).toBeDefined();
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

    // Non-string types must return 400 cleanly (never 500)
    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({ slot_id: 'slot-past', name: 'Alice', email: 789 })
      .expect(400)
      .expect({ error: 'email must be a string' });

    const invalidEmailAttempts = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM attempts WHERE email IN ('bad-email', '789')`,
    );
    expect(Number(invalidEmailAttempts.rows[0].count)).toBe(0);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({ slot_id: 123, name: 'Alice', email: 'types@example.com' })
      .expect(400)
      .expect({ error: 'slot_id must be a string' });

    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({ slot_id: 'slot-past', name: 456, email: 'types@example.com' })
      .expect(400)
      .expect({ error: 'name must be a string' });

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
      .expect({ error: 'slot has already started' });
  }, 20_000);

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

  it('POST /bookings supports Idempotency-Key replay (201/400/404/409), trimmed/lowercased body match, and 422 on mismatch', async () => {
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
          email: '  ALICE-IDEM@example.com ',
          name: '  alice ',
          slot_id: ' idem-slot ',
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

    // Caches 400 validation errors too
    const bad1 = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .set('Idempotency-Key', 'key-400')
      .send({
        slot_id: '',
        name: 'Bob',
        email: 'bob-idem@example.com',
      })
      .expect(400);

    const bad2 = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .set('Idempotency-Key', 'key-400')
      .send({
        email: 'BOB-IDEM@example.com',
        name: 'bob',
        slot_id: '   ',
      })
      .expect(400);

    expect(bad2.body).toEqual(bad1.body);

    // Caches 404 slot-not-found responses
    const missing1 = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .set('Idempotency-Key', 'key-404')
      .send({
        slot_id: 'missing-slot',
        name: 'Bob',
        email: 'bob-idem@example.com',
      })
      .expect(404);

    const missing2 = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .set('Idempotency-Key', 'key-404')
      .send({
        slot_id: 'missing-slot',
        name: 'Bob',
        email: 'bob-idem@example.com',
      })
      .expect(404);

    expect(missing2.body).toEqual(missing1.body);

    // Replays 409 identically
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
  }, 25_000);

  it('POST /bookings rate limits at 5 attempts/60s without recording 429s, replays cached idempotent responses while blocked, and isolates emails', async () => {
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

    // Attempt 1 (201) with Idempotency-Key
    const first = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .set('Idempotency-Key', 'rl-initial-201')
      .send({
        slot_id: 'rl-slot',
        name: 'Same User',
        email: '  RATE@Example.COM ',
      })
      .expect(201);

    // Attempts 2..5 (failures: 400, 404, 409, 409) all count toward the 5
    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({ slot_id: '', name: 'Same User', email: 'rate@example.com' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({
        slot_id: 'does-not-exist',
        name: 'Same User',
        email: 'rate@example.com',
      })
      .expect(404);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({ slot_id: 'rl-slot', name: 'Same User', email: 'rate@example.com' })
      .expect(409);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({ slot_id: 'rl-slot', name: 'Same User', email: 'rate@example.com' })
      .expect(409);

    // 6th and 7th requests hit 429 with Retry-After >= 1 and NEVER cache 429 or record more attempts
    const sixth = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .set('Idempotency-Key', 'rl-never-cache-429')
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

    await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .set('Idempotency-Key', 'rl-never-cache-429')
      .send({
        slot_id: 'rl-slot',
        name: 'Same User',
        email: 'rate@example.com',
      })
      .expect(429);

    const attemptRows = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM attempts WHERE email = 'rate@example.com'`,
    );
    expect(Number(attemptRows.rows[0].count)).toBe(5);

    const cached429 = await db.query(
      `SELECT key FROM idempotency_keys WHERE key = 'rl-never-cache-429'`,
    );
    expect(cached429.rows).toHaveLength(0);

    // Replaying an earlier cached idempotent request still returns 201 even while email is rate-limited
    const replayWhileBlocked = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .set('Idempotency-Key', 'rl-initial-201')
      .send({
        email: 'rate@example.com',
        name: 'same user',
        slot_id: 'RL-SLOT',
      })
      .expect(201);
    expect(replayWhileBlocked.body).toEqual(first.body);

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
  }, 25_000);

  it('DELETE /bookings/:id cancels, frees the slot for rebooking, and returns 409/404 appropriately', async () => {
    await request(app.getHttpServer())
      .post('/reset')
      .set('X-API-Key', apiKey)
      .send({
        slots: [
          {
            id: 'cancel-slot',
            provider: 'dr-smith',
            start: futureStart,
            end: futureEnd,
          },
        ],
      })
      .expect(200);

    await request(app.getHttpServer())
      .delete('/bookings/non-existent')
      .set('X-API-Key', apiKey)
      .expect(404)
      .expect({ error: 'booking not found' });

    const created = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({
        slot_id: 'cancel-slot',
        name: 'Alice',
        email: 'alice-cancel@example.com',
      })
      .expect(201);

    const cancelled = await request(app.getHttpServer())
      .delete(`/bookings/${created.body.id}`)
      .set('X-API-Key', apiKey)
      .expect(200);

    expect(cancelled.body).toEqual({
      ...created.body,
      status: 'cancelled',
    });
    expect(cancelled.body.seq).toBeUndefined();

    // Cancelling again returns 409
    await request(app.getHttpServer())
      .delete(`/bookings/${created.body.id}`)
      .set('X-API-Key', apiKey)
      .expect(409)
      .expect({ error: 'booking already cancelled' });

    // Slot is now free for a new confirmed booking
    const rebooked = await request(app.getHttpServer())
      .post('/bookings')
      .set('X-API-Key', apiKey)
      .send({
        slot_id: 'cancel-slot',
        name: 'Bob',
        email: 'bob-rebook@example.com',
      })
      .expect(201);

    expect(rebooked.body.id).not.toBe(created.body.id);
    expect(rebooked.body.status).toBe('confirmed');
  }, 15_000);

  it('GET /bookings validates email/limit/cursor and pages 25 bookings cleanly with limit=10', async () => {
    await request(app.getHttpServer())
      .post('/reset')
      .set('X-API-Key', apiKey)
      .send({
        slots: Array.from({ length: 25 }, (_, i) => ({
          id: `page-slot-${i}`,
          provider: 'dr-smith',
          start: futureStart,
          end: futureEnd,
        })),
      })
      .expect(200);

    await request(app.getHttpServer())
      .get('/bookings')
      .set('X-API-Key', apiKey)
      .expect(400)
      .expect({ error: 'email is required' });

    await request(app.getHttpServer())
      .get('/bookings?email=pager@example.com&limit=51')
      .set('X-API-Key', apiKey)
      .expect(400);

    await request(app.getHttpServer())
      .get('/bookings?email=pager@example.com&limit=0')
      .set('X-API-Key', apiKey)
      .expect(400);

    await request(app.getHttpServer())
      .get('/bookings?email=pager@example.com&cursor=not-valid!')
      .set('X-API-Key', apiKey)
      .expect(400);

    // Seed 25 bookings in order (first cancelled, rest confirmed)
    const ids = Array.from({ length: 25 }, (_, i) => `b-page-${i}`);
    const slotIds = Array.from({ length: 25 }, (_, i) => `page-slot-${i}`);
    const names = Array.from({ length: 25 }, (_, i) => `User ${i}`);
    const emails = Array.from({ length: 25 }, () => 'pager@example.com');
    const statuses = Array.from({ length: 25 }, (_, i) =>
      i === 0 ? 'cancelled' : 'confirmed',
    );
    await db.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       SELECT id, slot_id, name, email, status
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
         AS t(id, slot_id, name, email, status)`,
      [ids, slotIds, names, emails, statuses],
    );

    const p1 = await request(app.getHttpServer())
      .get('/bookings?email=PAGER@Example.COM&limit=10')
      .set('X-API-Key', apiKey)
      .expect(200);

    expect(p1.body.bookings).toHaveLength(10);
    expect(p1.body.bookings[0].status).toBe('cancelled');
    expect(p1.body.next_cursor).toEqual(expect.any(String));
    expect(p1.body.bookings[0].seq).toBeUndefined();

    const p2 = await request(app.getHttpServer())
      .get(`/bookings?email=pager@example.com&limit=10&cursor=${p1.body.next_cursor}`)
      .set('X-API-Key', apiKey)
      .expect(200);

    expect(p2.body.bookings).toHaveLength(10);
    expect(p2.body.next_cursor).toEqual(expect.any(String));

    const p3 = await request(app.getHttpServer())
      .get(`/bookings?email=pager@example.com&limit=10&cursor=${p2.body.next_cursor}`)
      .set('X-API-Key', apiKey)
      .expect(200);

    expect(p3.body.bookings).toHaveLength(5);
    expect(p3.body.next_cursor).toBeNull();

    const returnedIds = [
      ...p1.body.bookings,
      ...p2.body.bookings,
      ...p3.body.bookings,
    ].map((b: { id: string }) => b.id);
    expect(returnedIds).toEqual(ids);
  }, 20_000);

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
