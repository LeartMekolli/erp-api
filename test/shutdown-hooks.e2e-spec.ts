import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';

describe('shutdown hooks', () => {
  let app: INestApplication;

  afterAll(async () => {
    await app?.close();
  });

  it('configureApp makes SIGTERM close the application', async () => {
    const before = process.listenerCount('SIGTERM');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();

    configureApp(app);

    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
  });
});
