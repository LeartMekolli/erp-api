import { z } from 'zod';

export const QUEUES = ['notifications', 'maintenance'] as const;
export type QueueName = (typeof QUEUES)[number];

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 10_000;

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

export const JOBS = {} satisfies Record<string, JobDefinition<z.ZodType>>;

export const SCHEDULED_JOBS = {} satisfies Record<string, ScheduledJobDefinition>;

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
