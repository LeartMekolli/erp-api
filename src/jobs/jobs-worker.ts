import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { LOGGER } from '../common/logging/logger';
import { requestContext } from '../common/request-context/request-context';
import type { ErrorReporter } from '../common/reporting/error-reporter';
import { ERROR_REPORTER } from '../common/reporting/reporting.module';
import { ConfigService } from '../config/config.service';
import { HANDLES_JOB, JobHandler } from './handles-job';
import { createWorkerConnection } from './redis-connections';
import { JOB_REGISTRY } from './registry';
import type { JobRegistry } from './registry';

const CONCURRENCY = 5;

function tenantOf(payload: unknown): string | undefined {
  if (typeof payload === 'object' && payload !== null && 'tenantId' in payload) {
    return typeof payload.tenantId === 'string' ? payload.tenantId : undefined;
  }
  return undefined;
}

/**
 * Runs the registry's jobs. Lives only in the worker process (`worker.ts`);
 * the web process imports `JobsModule` alone and never consumes (ADR 0005.5).
 */
@Injectable()
export class JobsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly workers: Worker[] = [];
  private handlers = new Map<string, JobHandler<unknown>>();

  constructor(
    private readonly config: ConfigService,
    @Inject(JOB_REGISTRY) private readonly registry: JobRegistry,
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(ERROR_REPORTER) private readonly reporter: ErrorReporter,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.handlers = this.discoverHandlers();

    const connection = createWorkerConnection(this.config);
    const prefix = this.config.get('QUEUE_PREFIX');
    const queues = new Set(Object.values(this.registry.jobs).map((definition) => definition.queue));

    for (const queue of queues) {
      const worker = new Worker(queue, (job: Job) => this.run(queue, job), {
        connection,
        prefix,
        concurrency: CONCURRENCY,
      });
      // Without a listener a Redis error is an unhandled 'error' event and
      // takes the process down; BullMQ reconnects by itself.
      worker.on('error', (error) => this.logger.error({ err: error, queue }, 'worker error'));
      this.workers.push(worker);
    }

    await Promise.all(this.workers.map((worker) => worker.waitUntilReady()));
  }

  /**
   * Waits for active jobs to finish. On the destroy hook rather than shutdown,
   * so it runs in the same phase as the database disconnect instead of after it.
   */
  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }

  /** Every registry job has exactly one handler, and every handler a job; anything else refuses boot. */
  private discoverHandlers(): Map<string, JobHandler<unknown>> {
    const found = new Map<string, JobHandler<unknown>[]>();
    const problems: string[] = [];

    for (const { instance, metatype } of this.discovery.getProviders()) {
      if (!instance || !metatype) {
        continue;
      }
      const name = this.reflector.get<string | undefined>(HANDLES_JOB, metatype);
      if (!name) {
        continue;
      }
      if (!(name in this.registry.jobs)) {
        problems.push(`${metatype.name} handles unknown job ${name}`);
        continue;
      }
      found.set(name, [...(found.get(name) ?? []), instance as JobHandler<unknown>]);
    }

    const handlers = new Map<string, JobHandler<unknown>>();
    for (const name of Object.keys(this.registry.jobs)) {
      const candidates = found.get(name) ?? [];
      if (candidates.length === 0) {
        problems.push(`Job ${name} has no handler`);
      } else if (candidates.length > 1) {
        problems.push(`Job ${name} has ${candidates.length} handlers`);
      } else {
        handlers.set(name, candidates[0]);
      }
    }

    if (problems.length > 0) {
      throw new Error(`Job handlers are misconfigured: ${problems.join('; ')}`);
    }
    return handlers;
  }

  /**
   * One attempt. Logs id, name, attempt, duration and outcome — never the
   * payload, which may hold personal data. An invalid payload or an unknown
   * job is unrecoverable: retrying cannot fix it, so it dead-letters at once.
   */
  private async run(queue: string, job: Job): Promise<void> {
    const jobId = job.id ?? '';
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const definition = this.registry.jobs[job.name];
    const handler = this.handlers.get(job.name);
    const parsed = definition?.payload.safeParse(job.data);
    const tenantId = parsed?.success ? tenantOf(parsed.data) : undefined;

    await requestContext.run({ requestId: jobId, tenantId }, async () => {
      const started = performance.now();
      const line = (outcome: 'completed' | 'failed') => ({
        job: {
          id: jobId,
          name: job.name,
          queue,
          attempt,
          durationMs: Math.round(performance.now() - started),
          outcome,
        },
      });

      try {
        if (!handler || !parsed) {
          throw new UnrecoverableError(`Unknown job ${job.name}`);
        }
        if (!parsed.success) {
          // The schema's own message could echo payload values; this one cannot.
          throw new UnrecoverableError(`Invalid payload for ${job.name}`);
        }
        await handler.handle(parsed.data, { jobId, attempt, isFinalAttempt: attempt >= maxAttempts });
        this.logger.info(line('completed'), 'job');
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        const final = error instanceof UnrecoverableError || attempt >= maxAttempts;

        this.logger[final ? 'error' : 'warn']({ ...line('failed'), err: { message: error.message } }, 'job');

        if (final) {
          await this.deadLetter(job, handler, parsed?.success ? parsed.data : undefined, error, tenantId);
        }
        throw error;
      }
    });
  }

  private async deadLetter(
    job: Job,
    handler: JobHandler<unknown> | undefined,
    payload: unknown,
    error: Error,
    tenantId: string | undefined,
  ): Promise<void> {
    const jobId = job.id ?? '';

    if (handler?.onDeadLetter && payload !== undefined) {
      try {
        await handler.onDeadLetter(payload, error);
      } catch (hookError) {
        this.logger.error({ job: { id: jobId, name: job.name }, err: hookError }, 'onDeadLetter failed');
      }
    }

    this.reporter.report(error, { requestId: jobId, tenantId, jobId, jobName: job.name });
  }
}
