import { z } from 'zod';

function splitOrigins(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Scheme, host and optional port only: no `*`, path or trailing slash. */
function isExactOrigin(entry: string): boolean {
  if (!URL.canParse(entry)) {
    return false;
  }
  const url = new URL(entry);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === entry;
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    // How many reverse proxies sit in front of the API (Express `trust proxy`).
    // 0 never trusts X-Forwarded-For, which is right for a direct connection.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    // Browser origins allowed to call the API, comma separated, exact. Empty
    // sends no CORS headers at all. Tokens travel in the Authorization header,
    // so credentials stay off.
    CORS_ORIGINS: z
      .string()
      .default('')
      .refine((value) => splitOrigins(value).every(isExactOrigin), {
        message: 'must be exact origins such as https://app.example.com (no *, no path, no trailing slash)',
      })
      .transform(splitOrigins),
    // Also run the job consumers and scheduled jobs in the process that serves
    // HTTP. For hosts with no background workers (staging on Render's free
    // tier); elsewhere run `node dist/worker` separately.
    WORKER_IN_PROCESS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    // Serve the Swagger docs at /docs (and /docs/openapi.json). Off unless set,
    // so no deployment exposes them by accident.
    API_DOCS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    DATABASE_URL: z.string().min(1),
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
    // Tags events in Sentry. Unset, it is NODE_ENV; staging runs with
    // NODE_ENV=production and would otherwise be tagged as production.
    SENTRY_ENVIRONMENT: z.string().min(1).max(64).optional(),
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
    // Where feed-priced materials get their daily metal prices (Catalog spec C5, C6).
    // `fake` returns fixed prices, for local work and tests.
    METAL_PRICE_PROVIDER: z.enum(['fake', 'metalsdev']).default('fake'),
    // Required with metalsdev. Never logged.
    METAL_PRICE_API_KEY: z.string().min(1).optional(),
    // One provider call per currency per day; the free plan allows 100 a month (spec B5).
    METAL_PRICE_MAX_CURRENCIES: z.coerce.number().int().min(1).max(10).default(3),
    // A feed price older than this is flagged stale and staff are told (spec B6).
    METAL_PRICE_STALE_HOURS: z.coerce.number().int().min(1).max(720).default(48),
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
    if (env.METAL_PRICE_PROVIDER === 'metalsdev' && !env.METAL_PRICE_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['METAL_PRICE_API_KEY'],
        message: 'required when METAL_PRICE_PROVIDER is metalsdev',
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
