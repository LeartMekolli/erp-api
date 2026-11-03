import { ConfigService, createConfigService } from './config.service';
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
    // Parsed by loadEnv rather than written out, so a new variable never needs adding here.
    const config = new ConfigService(loadEnv({ ...valid, NODE_ENV: 'test', PORT: '3001' }));

    expect(config.get('NODE_ENV')).toBe('test');
    expect(config.get('PORT')).toBe(3001);
  });
});
