import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';

describe('application boot', () => {
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

  it('reports liveness without touching the database', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
  });

  it('serves application routes under the version prefix', async () => {
    await request(app.getHttpServer()).get('/v1').expect(200);
  });

  it('does not serve application routes without the prefix', async () => {
    await request(app.getHttpServer()).get('/').expect(404);
  });

  it('exposes the health probe outside the version prefix', async () => {
    await request(app.getHttpServer()).get('/v1/health/live').expect(404);
  });
});
