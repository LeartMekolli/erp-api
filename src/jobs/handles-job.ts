import { SetMetadata } from '@nestjs/common';

export const HANDLES_JOB = 'jobs:handles-job';

/** Where a handler is in its job's life; `attempt` starts at 1. */
export interface JobContext {
  jobId: string;
  attempt: number;
  isFinalAttempt: boolean;
}

/**
 * A job's code. Handlers must be safe to run again (ADR 0005.9): a retry
 * repeats the whole `handle`, whatever the failed attempt already did.
 */
export interface JobHandler<P> {
  handle(payload: P, ctx: JobContext): Promise<void>;
  /** Runs once, after the last attempt has failed. Its own errors are logged, not rethrown. */
  onDeadLetter?(payload: P, error: Error): Promise<void>;
}

/**
 * Marks a provider as the handler of one registry job. The worker finds it at
 * boot; every job needs exactly one.
 */
export const HandlesJob = (name: string): ClassDecorator => SetMetadata(HANDLES_JOB, name);
