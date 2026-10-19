import { Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../modules/identity/route-markers';
import { JobsService } from './jobs.service';
import { QUEUES } from './registry';

const queueSchema = z.enum(QUEUES);

/** Offset paging: ADR 0004's exception for small, bounded admin lists. */
const failedQuerySchema = z.object({
  queue: queueSchema,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface QueueCounts {
  queue: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface FailedJobResponse {
  queue: string;
  id: string | undefined;
  name: string;
  data: unknown;
  failed_reason: string;
  attempts_made: number;
  failed_at: string | null;
}

/**
 * The dead-letter view (J1): a queue's failed set is its dead letters. Job
 * payloads carry ids, never secrets, so showing them to a platform admin is
 * safe.
 */
@Controller('platform/jobs')
export class PlatformJobsController {
  constructor(private readonly jobs: JobsService) {}

  @RequirePermission('platform.jobs.read')
  @Get('queues')
  async queues(): Promise<{ data: QueueCounts[] }> {
    const data = await Promise.all(
      QUEUES.map(async (queue) => {
        const counts = await this.jobs.queue(queue).getJobCounts('waiting', 'active', 'delayed', 'failed');
        return {
          queue,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
        };
      }),
    );
    return { data };
  }

  /** Newest first. */
  @RequirePermission('platform.jobs.read')
  @Get('failed')
  async failed(
    @Query(new ZodValidationPipe(failedQuerySchema)) query: z.infer<typeof failedQuerySchema>,
  ): Promise<{ data: FailedJobResponse[] }> {
    const jobs = await this.jobs.queue(query.queue).getFailed(query.offset, query.offset + query.limit - 1);
    return {
      data: jobs.map((job) => ({
        queue: query.queue,
        id: job.id,
        name: job.name,
        data: job.data as unknown,
        failed_reason: job.failedReason,
        attempts_made: job.attemptsMade,
        failed_at: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      })),
    };
  }

  /** Back to waiting with its attempt counts reset, so it gets a full set of retries again. */
  @RequirePermission('platform.jobs.retry')
  @Post('failed/:queue/:id/retry')
  @HttpCode(204)
  async retry(
    @Param('queue', new ZodValidationPipe(queueSchema)) queue: z.infer<typeof queueSchema>,
    @Param('id') id: string,
  ): Promise<void> {
    const job = await this.jobs.queue(queue).getJob(id);
    if (!job || (await job.getState()) !== 'failed') {
      throw new NotFoundException('No failed job with that id in this queue');
    }
    await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
  }
}
