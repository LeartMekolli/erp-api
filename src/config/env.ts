import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  APP_SECRET: z.string().min(32),
  SENTRY_DSN: z.url().optional(),
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
