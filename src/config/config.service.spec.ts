import { ConfigService, createConfigService } from './config.service';

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

  it('refuses FILE_MAX_BYTES above the 5 GiB single-upload limit', () => {
    expect(createConfigService({ ...valid, FILE_MAX_BYTES: String(5 * 1024 ** 3) }).get('FILE_MAX_BYTES')).toBe(
      5 * 1024 ** 3,
    );
    expect(() => createConfigService({ ...valid, FILE_MAX_BYTES: String(5 * 1024 ** 3 + 1) })).toThrow(/FILE_MAX_BYTES/);
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
      TRUST_PROXY_HOPS: 0,
      CORS_ORIGINS: [],
      DATABASE_URL: 'postgresql://a',
      REDIS_URL: 'redis://c',
      APP_SECRET: 'b'.repeat(32),
      JWT_SECRET: 'c'.repeat(32),
      APP_BASE_DOMAIN: 'localhost',
      LOG_LEVEL: 'info',
      QUEUE_PREFIX: 'erp',
      SMTP_URL: 'smtp://localhost:1025',
      MAIL_FROM: 'ERP <no-reply@example.test>',
      WEB_URL_TEMPLATE: 'http://{tenant}.localhost:5173',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'auto',
      S3_BUCKET: 'erp-files',
      S3_ACCESS_KEY_ID: 'minio',
      S3_SECRET_ACCESS_KEY: 'minio-password',
      S3_FORCE_PATH_STYLE: 'true',
      FILE_MAX_BYTES: 104_857_600,
      SENTRY_DSN: undefined,
      SENTRY_ENVIRONMENT: undefined,
    });

    expect(config.get('NODE_ENV')).toBe('test');
    expect(config.get('PORT')).toBe(3001);
  });
});
