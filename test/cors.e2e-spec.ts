import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConfigService, createConfigService } from '../src/config/config.service';

describe('CORS', () => {
  const apps: INestApplication[] = [];
  const listed = 'https://app.example.test';
  const unlisted = 'https://evil.example.test';

  async function boot(origins?: string): Promise<INestApplication> {
    const source = { ...process.env };
    delete source.CORS_ORIGINS;
    if (origins !== undefined) {
      source.CORS_ORIGINS = origins;
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(createConfigService(source))
      .compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    apps.push(app);
    return app;
  }

  const preflight = (app: INestApplication, origin: string) =>
    request(app.getHttpServer())
      .options('/files')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key');

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('answers a preflight from a listed origin with the allow headers, and no credentials', async () => {
    const app = await boot(`${listed}, http://localhost:5173`);

    const response = await preflight(app, listed).expect(204);

    expect(response.headers['access-control-allow-origin']).toBe(listed);
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('adds nothing for an origin that is not listed', async () => {
    const app = await boot(listed);

    const response = await preflight(app, unlisted);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('adds nothing for anyone by default', async () => {
    const app = await boot();

    const response = await preflight(app, listed);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('marks a normal response from a listed origin', async () => {
    const app = await boot(listed);

    const response = await request(app.getHttpServer()).get('/health/live').set('Origin', listed).expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(listed);
  });
});
