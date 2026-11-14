import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DatabaseService } from './../src/database/database.service';

describe('App (e2e) - Step 1 Setup', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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
