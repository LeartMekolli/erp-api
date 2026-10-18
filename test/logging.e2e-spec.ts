import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { LOG_DESTINATION } from '../src/common/logging/logging.module';

/**
 * Captures what the application logs, through the real logger configuration,
 * so the redaction rules are tested as they run in production.
 */
describe('structured logging', () => {
  let app: INestApplication;
  const lines: string[] = [];

  const previousLevel = process.env.LOG_LEVEL;

  beforeAll(async () => {
    // The e2e default is warn; request lines are info.
    process.env.LOG_LEVEL = 'info';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOG_DESTINATION)
      .useValue({ write: (line: string) => lines.push(line) })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env.LOG_LEVEL = previousLevel;
  });

  beforeEach(() => {
    lines.length = 0;
  });

  it('logs one JSON line per request with request id, method, url and status', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/live')
      .set('x-request-id', 'trace-1')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('trace-1');

    // JSON.parse keeps the last of duplicated keys, so count them in the raw line.
    const raw = lines.find((line) => line.includes('"trace-1"')) ?? '';
    expect(raw.match(/"requestId"/g)).toHaveLength(1);

    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const entry = entries.find((candidate) => candidate.requestId === 'trace-1');

    expect(entry).toMatchObject({
      requestId: 'trace-1',
      req: { method: 'GET', url: '/health/live' },
      res: { statusCode: 200 },
    });
  });

  it('never logs the authorization header, cookies, the body or the query string', async () => {
    await request(app.getHttpServer())
      .post('/anything?token=query-secret')
      .set('Authorization', 'Bearer header-secret')
      .set('Cookie', 'session=cookie-secret')
      .send({ password: 'body-secret-password' });

    const output = lines.join('');

    expect(output).not.toBe('');
    for (const secret of ['header-secret', 'cookie-secret', 'body-secret-password', 'query-secret']) {
      expect(output).not.toContain(secret);
    }
  });
});
