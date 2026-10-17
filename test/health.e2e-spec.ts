import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { Public } from '../src/modules/identity/route-markers';

/** Stands in for any application route, so the prefix test owns its own. */
@Controller('prefix-fixture')
class PrefixFixtureController {
  @Public()
  @Get()
  get(): { ok: true } {
    return { ok: true };
  }
}

describe('application boot', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [PrefixFixtureController],
    }).compile();
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
    await request(app.getHttpServer()).get('/v1/prefix-fixture').expect(200, { ok: true });
  });

  it('does not serve application routes without the prefix', async () => {
    await request(app.getHttpServer()).get('/prefix-fixture').expect(404);
  });

  it('exposes the health probe outside the version prefix', async () => {
    await request(app.getHttpServer()).get('/v1/health/live').expect(404);
  });
});
