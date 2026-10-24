import { createHash } from 'node:crypto';
import { z } from 'zod';

export const QUEUES = ['notifications', 'maintenance', 'files'] as const;
export type QueueName = (typeof QUEUES)[number];

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 10_000;

/** Dead-lettered jobs stay visible this long (J1). */
export const FAILED_JOB_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export interface JobDefinition<S extends z.ZodType> {
  queue: QueueName;
  payload: S;
  /** Parts of the deduplication id; the same parts mean the same job. */
  jobId(payload: z.infer<S>): string[];
  attempts: number;
  backoffMs: number;
}

export interface ScheduledJobDefinition {
  queue: QueueName;
  schedule: { every: number } | { pattern: string; tz: string };
  /** How long one run may hold the scheduler lock. */
  lockTtlMs: number;
}

export function defineJob<S extends z.ZodType>(def: {
  queue: QueueName;
  payload: S;
  jobId: (payload: z.infer<S>) => string[];
  attempts?: number;
  backoffMs?: number;
}): JobDefinition<S> {
  return {
    queue: def.queue,
    payload: def.payload,
    jobId: def.jobId,
    attempts: def.attempts ?? DEFAULT_ATTEMPTS,
    backoffMs: def.backoffMs ?? DEFAULT_BACKOFF_MS,
  };
}

/** Short and stable, so an address never appears in a job id. */
function addressKey(address: string): string {
  return createHash('sha256').update(address).digest('hex').slice(0, 16);
}

export const JOBS = {
  // Resolves a notification's audience, writes the feed, queues one email per address.
  'notification.dispatch': defineJob({
    queue: 'notifications',
    payload: z.object({ tenantId: z.uuid(), notificationId: z.uuid() }),
    jobId: (p) => [p.notificationId],
  }),
  // Sends one notification to one address and logs the attempt. Ten attempts
  // from 30 s outlast about four hours of provider outage: invitation and
  // reset links are wiped once an email is given up on.
  'notification.email': defineJob({
    queue: 'notifications',
    payload: z.object({
      tenantId: z.uuid(),
      notificationId: z.uuid(),
      to: z.email(),
      locale: z.string(),
      userId: z.uuid().optional(),
    }),
    jobId: (p) => [p.notificationId, addressKey(p.to)],
    attempts: 10,
    backoffMs: 30_000,
  }),
  // Checksums a completed file version and runs its measurer (spec 5.3).
  'file.measure': defineJob({
    queue: 'files',
    payload: z.object({ tenantId: z.uuid(), fileId: z.uuid(), versionId: z.uuid() }),
    jobId: (p) => [p.versionId],
  }),
} satisfies Record<string, JobDefinition<z.ZodType>>;

export const SCHEDULED_JOBS = {
  // Recovers claimed work whose runner died and pending work whose job was lost (rule A1).
  'claims.sweep': { queue: 'maintenance', schedule: { every: 60_000 }, lockTtlMs: 55_000 },
  // Deletes idempotency keys older than 30 days (ADR 0005).
  'idempotency.cleanup': {
    queue: 'maintenance',
    schedule: { pattern: '0 3 * * *', tz: 'UTC' },
    lockTtlMs: 600_000,
  },
  // Fetches metal prices for feed-priced materials and flags stale ones (Catalog spec C5, B5, B6).
  'material.prices.fetch': {
    queue: 'maintenance',
    schedule: { pattern: '0 5 * * *', tz: 'UTC' },
    lockTtlMs: 600_000,
  },
  // Marks partner job offers past their deadline expired and tells staff (Partners spec, goal 10).
  // Whether an offer can still be accepted is decided by its deadline, never by this having run.
  'partners.offers.expire': { queue: 'maintenance', schedule: { every: 60_000 }, lockTtlMs: 55_000 },
} satisfies Record<string, ScheduledJobDefinition>;

export type JobName = keyof typeof JOBS;
export type JobPayload<N extends JobName> = (typeof JOBS)[N] extends {
  payload: infer P extends z.ZodType;
}
  ? z.infer<P>
  : never;

export interface JobRegistry {
  jobs: Record<string, JobDefinition<z.ZodType>>;
  scheduled: Record<string, ScheduledJobDefinition>;
}

/** DI token, so tests can swap in a fixture registry. */
export const JOB_REGISTRY = Symbol('JOB_REGISTRY');

export const DEFAULT_JOB_REGISTRY: JobRegistry = { jobs: JOBS, scheduled: SCHEDULED_JOBS };

/**
 * BullMQ forbids ':' in custom ids; '/' is the separator, so neither may
 * appear inside a part or the id would be ambiguous.
 */
export function buildJobId(name: string, parts: string[]): string {
  if (parts.length === 0) {
    throw new Error(`Job ${name} needs at least one id part`);
  }
  for (const part of parts) {
    if (part === '' || part.includes(':') || part.includes('/')) {
      throw new Error(`Invalid job id part "${part}" for ${name}`);
    }
  }
  return [name, ...parts].join('/');
}
