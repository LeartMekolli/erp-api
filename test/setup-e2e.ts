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
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
