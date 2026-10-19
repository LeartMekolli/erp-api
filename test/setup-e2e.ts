/**
 * End-to-end specs boot the real application, so the real environment has to be
 * valid before `ConfigModule`'s factory runs. These defaults stand in for a
 * developer's `.env`; anything already set (CI, a local `.env`) wins.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://erp_app:app_pw@localhost:5432/erp?schema=public',
  DATABASE_MIGRATE_URL: 'postgresql://erp_owner:owner_pw@localhost:5432/erp?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  APP_SECRET: 'test_secret_that_is_at_least_32_characters',
  JWT_SECRET: 'test_jwt_secret_that_is_at_least_32_characters',
  QUEUE_PREFIX: 'e2e',
  // Request logs would drown test output; logging tests capture their own.
  LOG_LEVEL: 'warn',
  SMTP_URL: 'smtp://localhost:1025',
  MAIL_FROM: 'ERP <no-reply@example.test>',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
