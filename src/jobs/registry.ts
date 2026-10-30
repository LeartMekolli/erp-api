import { createHash } from 'node:crypto';
import { z } from 'zod';

export const QUEUES = ['notifications', 'maintenance', 'files', 'payments', 'ai'] as const;
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
  // Applies one stored payment webhook event by its type (Payments spec, goal 10).
  'payments.event': defineJob({
    queue: 'payments',
    payload: z.object({ tenantId: z.uuid(), eventId: z.uuid() }),
    jobId: (p) => [p.eventId],
  }),
  // Invoices a shipped pay-later order not paid, once (Payments spec).
  'payments.invoice.create': defineJob({
    queue: 'payments',
    payload: z.object({ tenantId: z.uuid(), orderId: z.uuid() }),
    jobId: (p) => [p.orderId],
  }),
  // Asks the provider for one pending refund and settles it when the provider has (Payments spec).
  'payments.refund': defineJob({
    queue: 'payments',
    payload: z.object({ tenantId: z.uuid(), refundId: z.uuid() }),
    jobId: (p) => [p.refundId],
  }),
  // Transfers one pending payout to its partner and settles it (Payments spec).
  'payments.payout.transfer': defineJob({
    queue: 'payments',
    payload: z.object({ tenantId: z.uuid(), payoutId: z.uuid() }),
    jobId: (p) => [p.payoutId],
  }),
  // Runs one AI call and writes its result; after the last attempt, a failed result (AI 1 spec).
  'ai.run': defineJob({
    queue: 'ai',
    payload: z.object({ tenantId: z.uuid(), runId: z.uuid() }),
    jobId: (p) => [p.runId],
    attempts: 3,
  }),
  // Gives a failed customer run's credits back (AI 2 spec, goal 5); a second time gives nothing.
  'ai.credits.give_back': defineJob({
    queue: 'ai',
    payload: z.object({ tenantId: z.uuid(), runId: z.uuid() }),
    jobId: (p) => [p.runId],
    attempts: 5,
  }),
  // Tells staff of the AI-limit notice levels crossed once a platform admin has set the limit (AI 1 review
  // fixes). `at` is when it was set, in ms, so each change checks once.
  'ai.limit.check': defineJob({
    queue: 'ai',
    payload: z.object({ tenantId: z.uuid(), at: z.string().regex(/^\d+$/) }),
    jobId: (p) => [p.tenantId, p.at],
  }),
  // Puts one article's passages in the vector store as it reads now: published, or removed (AI 1 spec).
  // `version` is the article's updated_at, so each edit indexes once.
  'knowledge.index': defineJob({
    queue: 'ai',
    payload: z.object({ tenantId: z.uuid(), articleId: z.uuid(), version: z.string().regex(/^\d+$/) }),
    jobId: (p) => [p.articleId, p.version],
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
  // Keeps each partner's load and capacity per step type for the day (Partners spec, D83).
  'partners.capacity.snapshot': {
    queue: 'maintenance',
    schedule: { pattern: '0 2 * * *', tz: 'UTC' },
    lockTtlMs: 600_000,
  },
  // Cancels pay-first orders not paid by their deadline (Payments spec). Whether an order may still be
  // paid is decided by its state under its lock, never by this having run.
  'payments.unpaid.cancel': { queue: 'payments', schedule: { every: 60_000 }, lockTtlMs: 55_000 },
  // Tells the customer and staff of each invoice past its due date, once (Payments spec).
  'payments.invoices.overdue': {
    queue: 'payments',
    schedule: { pattern: '0 6 * * *', tz: 'UTC' },
    lockTtlMs: 600_000,
  },
  // Mondays: tells staff who pay which partners have money due (Payments spec).
  'payments.payouts.remind': {
    queue: 'payments',
    schedule: { pattern: '0 7 * * 1', tz: 'UTC' },
    lockTtlMs: 600_000,
  },
  // Writes off what is left of expired credit grants (Payments 2 spec). Whether credits can be spent
  // is decided by their expiry, never by this having run.
  'payments.credits.expire': { queue: 'payments', schedule: { every: 900_000 }, lockTtlMs: 600_000 },
  // Grants each customer the monthly allowance it is owed (Payments 2 spec, goal 9); granted once per
  // month by its source key, however often this runs.
  'payments.credits.allowances': { queue: 'payments', schedule: { every: 900_000 }, lockTtlMs: 600_000 },
  // Grants running campaigns to the customers they target and haven't reached yet (Payments 2 spec);
  // once per customer and campaign, however often this runs.
  'payments.campaigns.grant': { queue: 'payments', schedule: { every: 300_000 }, lockTtlMs: 280_000 },
  // Recomputes every workspace's dashboard numbers for this week and last (AI 1 spec, goal 4).
  'reports.refresh': { queue: 'maintenance', schedule: { every: 900_000 }, lockTtlMs: 600_000 },
  // Queues the morning briefing of each workspace where it is 07:00 or later and none ran today (AI 1 spec, goal 7).
  'ai.briefing': { queue: 'ai', schedule: { every: 900_000 }, lockTtlMs: 600_000 },
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
