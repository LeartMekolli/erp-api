import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { ConfigService } from '../config/config.service';
import { closeSharedClient, createSharedClient } from './redis-connections';
import {
  buildJobId,
  FAILED_JOB_RETENTION_SECONDS,
  JOB_REGISTRY,
  JobName,
  JobPayload,
  QUEUES,
  QueueName,
} from './registry';
import type { JobRegistry } from './registry';

@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly queues: Record<QueueName, Queue>;
  private readonly connection: Redis;

  constructor(
    config: ConfigService,
    @Inject(JOB_REGISTRY) private readonly registry: JobRegistry,
  ) {
    const connection = createSharedClient(config, 'producer');
    // Without a listener, a connection error is an unhandled 'error' event; each queue reports its own.
    connection.on('error', () => undefined);
    this.connection = connection;
    const prefix = config.get('QUEUE_PREFIX');
    this.queues = Object.fromEntries(
      QUEUES.map((name) => {
        const queue = new Queue(name, { connection, prefix });
        // Without a listener, a connection error is an unhandled 'error' event
        // and takes the process down.
        queue.on('error', () => undefined);
        return [name, queue];
      }),
    ) as Record<QueueName, Queue>;
  }

  queue(name: QueueName): Queue {
    return this.queues[name];
  }

  /**
   * Validates the payload, then adds the job under a deterministic id so
   * enqueueing the same subject twice keeps one job. A ZodError propagates.
   */
  async enqueue<N extends JobName>(name: N, payload: JobPayload<N>): Promise<void> {
    const definition = this.registry.jobs[name];
    if (!definition) {
      throw new Error(`Unknown job ${name}`);
    }
    const data: unknown = definition.payload.parse(payload);
    await this.queues[definition.queue].add(name, data, {
      jobId: buildJobId(name, definition.jobId(data)),
      attempts: definition.attempts,
      backoff: { type: 'exponential', delay: definition.backoffMs },
      removeOnComplete: true,
      removeOnFail: { age: FAILED_JOB_RETENTION_SECONDS },
    });
  }

  /**
   * Like `enqueue`, but also revives the job if it sits in the failed set.
   * A dead-lettered job keeps its id for 30 days (J1), so a plain enqueue of
   * the same work would be a silent no-op. Used by the claim sweeper.
   */
  async requeue<N extends JobName>(name: N, payload: JobPayload<N>): Promise<void> {
    const definition = this.registry.jobs[name];
    if (!definition) {
      throw new Error(`Unknown job ${name}`);
    }
    const data: unknown = definition.payload.parse(payload);
    const existing = await this.queues[definition.queue].getJob(buildJobId(name, definition.jobId(data)));
    if (existing && (await existing.getState()) === 'failed') {
      await existing.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
      return;
    }
    await this.enqueue(name, payload);
  }

  async onModuleDestroy(): Promise<void> {
    // The queues share one connection, which they never close themselves.
    await Promise.all(Object.values(this.queues).map((queue) => queue.close()));
    await closeSharedClient(this.connection);
  }
}
