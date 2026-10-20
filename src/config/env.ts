import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    DATABASE_MIGRATE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    APP_SECRET: z.string().min(32),
    JWT_SECRET: z.string().min(32),
    // Tenants log in at <slug>.<APP_BASE_DOMAIN> (F5).
    APP_BASE_DOMAIN: z.string().min(1).default('localhost'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    // Namespaces every queue key in Redis, so environments and e2e specs sharing
    // one Redis never see each other's jobs.
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .default('erp'),
    SENTRY_DSN: z.url().optional(),
    // Mailpit locally (smtp://localhost:1025), Resend's SMTP endpoint in production (F7).
    SMTP_URL: z.url(),
    // The sender when a tenant has not set notification.sender: an address, or "Name <address>".
    MAIL_FROM: z.string().regex(/@/, 'must contain an email address'),
    // Where links in emails point: the web app, with {tenant} replaced by the tenant's slug (plan N8).
    WEB_URL_TEMPLATE: z
      .string()
      .refine((value) => value.includes('{tenant}'), 'must contain {tenant}')
      .refine((value) => URL.canParse(value.replace('{tenant}', 'tenant')), 'must be a URL'),
    // File storage, any S3-compatible service: MinIO locally, Cloudflare R2 in production (plan S1).
    S3_ENDPOINT: z.url(),
    // Where clients reach storage, when that differs from where the API does
    // (in Compose, the API uses minio:9000 and a browser localhost:9000).
    // Signed links name this address; unset, they name S3_ENDPOINT.
    S3_PUBLIC_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().min(1).default('auto'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    // MinIO serves buckets at <endpoint>/<bucket>; R2 accepts either form.
    S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
    // The largest upload accepted, in bytes (plan S4). At most 5 GiB, the
    // largest single PUT that S3 and R2 accept.
    FILE_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(5 * 1024 ** 3)
      .default(104_857_600),
  })
  .superRefine((env, ctx) => {
    // One leaked secret must not compromise both cursors and access tokens.
    if (env.JWT_SECRET === env.APP_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'must differ from APP_SECRET',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parses the environment once, at boot. Every missing or malformed variable is
 * reported together, so a misconfigured deployment fails on its first start
 * with the whole list rather than one variable per restart.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }

  return parsed.data;
}
