import { loadEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://erp_app:pw@localhost:5432/erp',
  DATABASE_MIGRATE_URL: 'postgresql://erp_owner:pw@localhost:5432/erp',
  REDIS_URL: 'redis://localhost:6379',
  APP_SECRET: 'a'.repeat(32),
  JWT_SECRET: 'j'.repeat(32),
  SMTP_URL: 'smtp://localhost:1025',
  MAIL_FROM: 'ERP <no-reply@example.test>',
} as NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('returns defaults for optional values', () => {
    const env = loadEnv({ ...valid });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it('coerces PORT to a number', () => {
    expect(loadEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('names every missing variable in one error', () => {
    let message = '';
    try {
      loadEnv({});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('DATABASE_MIGRATE_URL');
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('APP_SECRET');
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadEnv({ ...valid, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('rejects an APP_SECRET shorter than 32 characters', () => {
    expect(() => loadEnv({ ...valid, APP_SECRET: 'short' })).toThrow(/APP_SECRET/);
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('rejects a JWT_SECRET equal to APP_SECRET', () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: valid.APP_SECRET })).toThrow(
      /JWT_SECRET: must differ from APP_SECRET/,
    );
  });

  it('defaults APP_BASE_DOMAIN and LOG_LEVEL', () => {
    expect(loadEnv({ ...valid })).toMatchObject({ APP_BASE_DOMAIN: 'localhost', LOG_LEVEL: 'info' });
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('rejects a SENTRY_DSN that is not a URL', () => {
    expect(() => loadEnv({ ...valid, SENTRY_DSN: 'nonsense' })).toThrow(/SENTRY_DSN/);
  });
});
