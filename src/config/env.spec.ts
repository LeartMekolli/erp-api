import { loadEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://erp_app:pw@localhost:5432/erp',
  REDIS_URL: 'redis://localhost:6379',
  APP_SECRET: 'a'.repeat(32),
  JWT_SECRET: 'j'.repeat(32),
  SMTP_URL: 'smtp://localhost:1025',
  MAIL_FROM: 'ERP <no-reply@example.test>',
  WEB_URL_TEMPLATE: 'http://{tenant}.localhost:5173',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'erp-files',
  S3_ACCESS_KEY_ID: 'minio',
  S3_SECRET_ACCESS_KEY: 'minio-password',
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
    expect(message).not.toContain('DATABASE_MIGRATE_URL');
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('APP_SECRET');
  });

  it('does not read DATABASE_MIGRATE_URL: only the Prisma CLI does', () => {
    const env = loadEnv({ ...valid, DATABASE_MIGRATE_URL: 'postgresql://erp_owner:pw@localhost:5432/erp' });

    expect('DATABASE_MIGRATE_URL' in env).toBe(false);
  });

  it('defaults TRUST_PROXY_HOPS to 0 and accepts 0 to 5', () => {
    expect(loadEnv({ ...valid }).TRUST_PROXY_HOPS).toBe(0);
    expect(loadEnv({ ...valid, TRUST_PROXY_HOPS: '5' }).TRUST_PROXY_HOPS).toBe(5);
  });

  it.each(['-1', '6', '1.5', 'many'])('rejects TRUST_PROXY_HOPS=%s', (value) => {
    expect(() => loadEnv({ ...valid, TRUST_PROXY_HOPS: value })).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('defaults CORS_ORIGINS to an empty list', () => {
    expect(loadEnv({ ...valid }).CORS_ORIGINS).toEqual([]);
  });

  it('parses CORS_ORIGINS, trimming spaces and dropping empty entries', () => {
    const env = loadEnv({ ...valid, CORS_ORIGINS: ' https://app.example.test , http://localhost:5173,, ' });

    expect(env.CORS_ORIGINS).toEqual(['https://app.example.test', 'http://localhost:5173']);
  });

  it.each(['*', 'https://app.example.test/app', 'https://app.example.test/', 'app.example.test', 'localhost:5173'])(
    'rejects CORS_ORIGINS=%s',
    (value) => {
      expect(() => loadEnv({ ...valid, CORS_ORIGINS: value })).toThrow(/CORS_ORIGINS/);
    },
  );

  it('defaults WORKER_IN_PROCESS to false and reads true and false', () => {
    expect(loadEnv({ ...valid }).WORKER_IN_PROCESS).toBe(false);
    expect(loadEnv({ ...valid, WORKER_IN_PROCESS: 'true' }).WORKER_IN_PROCESS).toBe(true);
    expect(loadEnv({ ...valid, WORKER_IN_PROCESS: 'false' }).WORKER_IN_PROCESS).toBe(false);
  });

  it.each(['1', 'yes', 'TRUE', ''])('rejects WORKER_IN_PROCESS=%j', (value) => {
    expect(() => loadEnv({ ...valid, WORKER_IN_PROCESS: value })).toThrow(/WORKER_IN_PROCESS/);
  });

  it('defaults the metal price feed to the fake provider, 3 currencies and 48 hours', () => {
    expect(loadEnv({ ...valid })).toMatchObject({
      METAL_PRICE_PROVIDER: 'fake',
      METAL_PRICE_MAX_CURRENCIES: 3,
      METAL_PRICE_STALE_HOURS: 48,
    });
    expect(loadEnv({ ...valid }).METAL_PRICE_API_KEY).toBeUndefined();
  });

  it('requires an API key for the metals.dev provider', () => {
    expect(() => loadEnv({ ...valid, METAL_PRICE_PROVIDER: 'metalsdev' })).toThrow(/METAL_PRICE_API_KEY/);
    expect(loadEnv({ ...valid, METAL_PRICE_PROVIDER: 'metalsdev', METAL_PRICE_API_KEY: 'k' }).METAL_PRICE_API_KEY).toBe('k');
  });

  it.each([
    ['METAL_PRICE_PROVIDER', 'other'],
    ['METAL_PRICE_MAX_CURRENCIES', '0'],
    ['METAL_PRICE_MAX_CURRENCIES', '11'],
    ['METAL_PRICE_STALE_HOURS', '0'],
    ['METAL_PRICE_STALE_HOURS', '721'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadEnv({ ...valid, [name]: value })).toThrow(new RegExp(name));
  });

  it('defaults PAYMENT_PROVIDER to fake and reads stripe', () => {
    expect(loadEnv({ ...valid }).PAYMENT_PROVIDER).toBe('fake');
    expect(loadEnv({ ...valid, PAYMENT_PROVIDER: 'stripe' }).PAYMENT_PROVIDER).toBe('stripe');
  });

  it('rejects PAYMENT_PROVIDER=other', () => {
    expect(() => loadEnv({ ...valid, PAYMENT_PROVIDER: 'other' })).toThrow(/PAYMENT_PROVIDER/);
  });

  it('defaults API_DOCS to false and reads true', () => {
    expect(loadEnv({ ...valid }).API_DOCS).toBe(false);
    expect(loadEnv({ ...valid, API_DOCS: 'true' }).API_DOCS).toBe(true);
  });

  it.each(['1', 'yes', ''])('rejects API_DOCS=%j', (value) => {
    expect(() => loadEnv({ ...valid, API_DOCS: value })).toThrow(/API_DOCS/);
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

  it('leaves SENTRY_ENVIRONMENT unset by default', () => {
    expect(loadEnv({ ...valid }).SENTRY_ENVIRONMENT).toBeUndefined();
    expect(loadEnv({ ...valid, SENTRY_ENVIRONMENT: 'staging' }).SENTRY_ENVIRONMENT).toBe('staging');
  });

  it('rejects a SENTRY_DSN that is not a URL', () => {
    expect(() => loadEnv({ ...valid, SENTRY_DSN: 'nonsense' })).toThrow(/SENTRY_DSN/);
  });
});
