import { createConfigService } from '../../config/config.service';
import { NoopErrorReporter, SentryErrorReporter } from './error-reporter';
import { createErrorReporter } from './reporting.module';

const base = {
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
  SENTRY_DSN: 'https://key@sentry.example.test/1',
} as NodeJS.ProcessEnv;

function fakeSentry() {
  return { init: jest.fn(), captureException: jest.fn() };
}

describe('createErrorReporter', () => {
  it('tags events with SENTRY_ENVIRONMENT when it is set', () => {
    const sentry = fakeSentry();

    const reporter = createErrorReporter(
      createConfigService({ ...base, NODE_ENV: 'production', SENTRY_ENVIRONMENT: 'staging' }),
      sentry,
    );

    expect(sentry.init).toHaveBeenCalledWith({ dsn: base.SENTRY_DSN, environment: 'staging' });
    expect(reporter).toBeInstanceOf(SentryErrorReporter);
  });

  it('falls back to NODE_ENV', () => {
    const sentry = fakeSentry();

    createErrorReporter(createConfigService({ ...base, NODE_ENV: 'production' }), sentry);

    expect(sentry.init).toHaveBeenCalledWith({ dsn: base.SENTRY_DSN, environment: 'production' });
  });

  it('initialises nothing without a DSN', () => {
    const sentry = fakeSentry();
    const source = { ...base };
    delete source.SENTRY_DSN;

    const reporter = createErrorReporter(createConfigService(source), sentry);

    expect(sentry.init).not.toHaveBeenCalled();
    expect(reporter).toBeInstanceOf(NoopErrorReporter);
  });
});
