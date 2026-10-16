import { ConfigService, createConfigService } from './config.service';

const valid = {
  DATABASE_URL: 'postgresql://erp_app:pw@localhost:5432/erp',
  DATABASE_MIGRATE_URL: 'postgresql://erp_owner:pw@localhost:5432/erp',
  REDIS_URL: 'redis://localhost:6379',
  APP_SECRET: 'a'.repeat(32),
  JWT_SECRET: 'j'.repeat(32),
} as NodeJS.ProcessEnv;

describe('ConfigService', () => {
  it('returns validated values, typed and coerced', () => {
    const config = createConfigService({ ...valid, PORT: '8080' });

    expect(config.get('PORT')).toBe(8080);
    expect(config.get('DATABASE_URL')).toBe('postgresql://erp_app:pw@localhost:5432/erp');
    expect(config.get('NODE_ENV')).toBe('development');
  });

  it('refuses to be created from an invalid environment', () => {
    expect(() => createConfigService({})).toThrow(/DATABASE_URL/);
  });

  it('reads the environment once, so later changes to the source are ignored', () => {
    const source = { ...valid, PORT: '8080' };
    const config = createConfigService(source);

    source.PORT = '9999';

    expect(config.get('PORT')).toBe(8080);
  });

  it('can be constructed directly from an already-parsed environment', () => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      PORT: 3001,
      DATABASE_URL: 'postgresql://a',
      DATABASE_MIGRATE_URL: 'postgresql://b',
      REDIS_URL: 'redis://c',
      APP_SECRET: 'b'.repeat(32),
      JWT_SECRET: 'c'.repeat(32),
      APP_BASE_DOMAIN: 'localhost',
      LOG_LEVEL: 'info',
      SENTRY_DSN: undefined,
    });

    expect(config.get('NODE_ENV')).toBe('test');
    expect(config.get('PORT')).toBe(3001);
  });
});
