import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { z, ZodError } from 'zod';
import { AppModule } from '../src/app.module';
import { newId } from '../src/common/ids/uuid';
import { JobsService } from '../src/jobs/jobs.service';
import { defineJob, JOB_REGISTRY, JobName, JobRegistry } from '../src/jobs/registry';

const echo = 'test.echo' as JobName;

describe('job producer', () => {
  let jobs: JobsService;
  let close: (() => Promise<void>) | undefined;

  const fixture: JobRegistry = {
    jobs: {
      'test.echo': defineJob({
        queue: 'maintenance',
        payload: z.object({ subjectId: z.uuid() }),
        jobId: (p) => [p.subjectId],
      }),
    },
    scheduled: {},
  };

  const enqueue = (payload: unknown) =>
    jobs.enqueue(echo, payload as Parameters<JobsService['enqueue']>[1]);

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOB_REGISTRY)
      .useValue(fixture)
      .compile();
    await moduleRef.init();
    jobs = moduleRef.get(JobsService);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await jobs?.queue('maintenance').obliterate({ force: true });
    await close?.();
  });

  it('enqueues a job under its encoded id', async () => {
    const subjectId = newId();
    await enqueue({ subjectId });

    const job = await jobs.queue('maintenance').getJob(`test.echo/${subjectId}`);
    expect(job?.data).toEqual({ subjectId });
  });

  it('enqueueing the same subject twice keeps one job', async () => {
    await jobs.queue('maintenance').obliterate({ force: true });
    const subjectId = newId();
    await enqueue({ subjectId });
    await enqueue({ subjectId });

    const counts = await jobs.queue('maintenance').getJobCounts('waiting');
    expect(counts.waiting).toBe(1);
  });

  it('rejects an invalid payload', async () => {
    await jobs.queue('maintenance').obliterate({ force: true });
    await expect(enqueue({ subjectId: 'x' })).rejects.toBeInstanceOf(ZodError);

    const counts = await jobs.queue('maintenance').getJobCounts('waiting');
    expect(counts.waiting).toBe(0);
  });

  it('the web process consumes nothing', async () => {
    const subjectId = newId();
    await enqueue({ subjectId });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const job = await jobs.queue('maintenance').getJob(`test.echo/${subjectId}`);
    await expect(job?.getState()).resolves.toBe('waiting');
  });
});
