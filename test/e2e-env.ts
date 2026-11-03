import { createHash } from 'node:crypto';

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
  WEB_URL_TEMPLATE: 'http://{tenant}.localhost:5173',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'erp-files',
  S3_ACCESS_KEY_ID: 'minio',
  S3_SECRET_ACCESS_KEY: 'minio-password',
  S3_FORCE_PATH_STYLE: 'true',
  // No spec's worker runs the scheduled jobs over every spec's workspaces: specs call the per-workspace
  // methods (runDue, queueDue, sweepTenant…). schedulers and worker-in-process turn it on.
  JOB_SCHEDULES: 'false',
};

export function applyE2eDefaults(): void {
  for (const [key, value] of Object.entries(defaults)) {
    process.env[key] ??= value;
  }
}

/** One set of e2e databases per checkout, so two workspaces' runs on one Postgres never meet. */
const checkout = createHash('sha1').update(process.cwd()).digest('hex').slice(0, 8);

/** Migrated once per run; every worker's database is a copy of it (global-setup-e2e.ts). */
export const templateDatabase = `erp_e2e_${checkout}_template`;

export const workerDatabase = (worker: string | number): string => `erp_e2e_${checkout}_${worker}`;

/** The same connection string, pointed at another database on the same server. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
