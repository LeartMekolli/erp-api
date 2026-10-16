import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';

/**
 * Runs against the real Compose stack: `docker compose up -d` first.
 */
describe('readiness', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports both dependencies reachable', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready');

    // Body first: a failure then names which dependency was unreachable,
    // rather than only reporting 503 instead of 200.
    expect(response.body).toEqual({
      status: 'ok',
      checks: { database: true, redis: true },
    });
    expect(response.status).toBe(200);
  });

  it('stays outside the version prefix', async () => {
    await request(app.getHttpServer()).get('/v1/health/ready').expect(404);
  });
});
