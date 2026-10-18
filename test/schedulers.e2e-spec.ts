import { randomBytes } from 'node:crypto';
import { TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import { ClaimSweeper } from '../src/jobs/claim-sweeper';
import { JobsService } from '../src/jobs/jobs.service';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

describe('scheduled jobs', () => {
  const workers: TestingModule[] = [];
  let prefix: string;

  beforeEach(() => {
    prefix = `t${randomBytes(6).toString('hex')}`;
    process.env.QUEUE_PREFIX = prefix;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const first = workers[0];
    if (first) {
      await first.get(JobsService).queue('maintenance').obliterate({ force: true });
    }
    for (const worker of workers.splice(0)) {
      await worker.close();
    }
  });

  it('two workers upsert one scheduler', async () => {
    workers.push(await startTestWorker(), await startTestWorker());

    const schedulers = await workers[0].get(JobsService).queue('maintenance').getJobSchedulers();
    expect(schedulers.filter((scheduler) => scheduler.key === 'claims.sweep')).toHaveLength(1);
  });

  it('a scheduled run skips while the lock is held', async () => {
    const sweep = jest.spyOn(ClaimSweeper.prototype, 'sweep');

    // Held by "another instance" before this worker boots, so every run skips,
    // including any the scheduler starts at once.
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    await redis.set(`lock:job:${prefix}:claims.sweep`, 'other-instance', 'PX', 10_000);
    await redis.quit();

    workers.push(await startTestWorker());
    const worker = workers[0];

    const queue = worker.get(JobsService).queue('maintenance');
    const jobId = `claims.sweep/manual-${randomBytes(4).toString('hex')}`;
    await queue.add('claims.sweep', {}, { jobId, removeOnComplete: true });

    // A skipped run completes normally, and completed jobs are removed.
    await waitFor(async () => ((await queue.getJob(jobId)) ? undefined : true));
    expect(sweep).not.toHaveBeenCalled();
  });
});
