import { ConfigService } from '../config/config.service';
import { loadEnv } from '../config/env';
import { createProducerConnection, createWorkerConnection } from './redis-connections';

function configFor(redisUrl: string): ConfigService {
  return new ConfigService(
    loadEnv({
      DATABASE_URL: 'x',
      DATABASE_MIGRATE_URL: 'x',
      REDIS_URL: redisUrl,
      APP_SECRET: 'a'.repeat(32),
      JWT_SECRET: 'b'.repeat(32),
    }),
  );
}

describe('redis connections', () => {
  it('parses host, port, password and db from the url', () => {
    expect(createProducerConnection(configFor('redis://:s%40crt@cache.test:6380/2'))).toMatchObject(
      { host: 'cache.test', port: 6380, password: 's@crt', db: 2 },
    );
  });

  it('defaults the port and omits unset parts', () => {
    const options = createProducerConnection(configFor('redis://localhost'));
    expect(options).toMatchObject({ host: 'localhost', port: 6379 });
    expect(options).not.toHaveProperty('password');
    expect(options).not.toHaveProperty('db');
    expect(options).not.toHaveProperty('tls');
  });

  it('enables tls for rediss', () => {
    expect(createProducerConnection(configFor('rediss://cache.test:6379'))).toHaveProperty('tls');
  });

  it('bounds retries for the producer and lifts them for the worker', () => {
    const config = configFor('redis://localhost:6379');
    expect(createProducerConnection(config)).toMatchObject({
      maxRetriesPerRequest: 2,
      connectTimeout: 2000,
    });
    expect(createWorkerConnection(config)).toMatchObject({ maxRetriesPerRequest: null });
  });
});
