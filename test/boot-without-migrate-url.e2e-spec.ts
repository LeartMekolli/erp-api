import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConfigService, createConfigService } from '../src/config/config.service';

describe('boot without the owner database URL', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // What the Render service sees: the application's variables, never the owner's.
    const source = { ...process.env };
    delete source.DATABASE_MIGRATE_URL;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(createConfigService(source))
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('starts and answers readiness', async () => {
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });
});
