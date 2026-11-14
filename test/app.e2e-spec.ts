import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  API_KEY_SECURITY,
  setupSwagger,
} from './../src/config/swagger.config';
import { DatabaseService } from './../src/database/database.service';

describe('App (e2e) - Step 1 Setup & Swagger', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupSwagger(app);
    await app.init();
    db = app.get(DatabaseService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('connects to Postgres via pg pool', async () => {
    await expect(db.ping()).resolves.toBe(true);
  });

  it('GET / returns 200', async () => {
    await request(app.getHttpServer())
      .get('/')
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

  it('returns {"error": ...} for unknown routes (404)', async () => {
    const res = await request(app.getHttpServer())
      .get('/does-not-exist')
      .expect(404);

    expect(res.body).toEqual({
      error: expect.any(String),
    });
    expect(Object.keys(res.body)).toEqual(['error']);
  });

  it('returns {"error": ...} for malformed JSON bodies (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/does-not-exist')
      .set('Content-Type', 'application/json')
      .send('{"broken": ')
      .expect(400);

    expect(res.body).toEqual({
      error: expect.any(String),
    });
    expect(Object.keys(res.body)).toEqual(['error']);
  });
});
