import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { z } from 'zod';
import { newId } from '../src/common/ids/uuid';
import { LOG_DESTINATION } from '../src/common/logging/logging.module';
import { requestContext } from '../src/common/request-context/request-context';
import { ERROR_REPORTER } from '../src/common/reporting/reporting.module';
import { HandlesJob, JobContext, JobHandler } from '../src/jobs/handles-job';
import { JobsService } from '../src/jobs/jobs.service';
import { defineJob, JOB_REGISTRY, JobName, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

type Payload = { id: string; tenantId?: string; note?: string };

const payload = z.object({ id: z.uuid(), tenantId: z.uuid().optional(), note: z.string().optional() });
const fixtureJob = () =>
  defineJob({ queue: 'maintenance', payload, jobId: (p) => [p.id], attempts: 3, backoffMs: 10 });

const fixture: JobRegistry = {
  jobs: { 'test.ok': fixtureJob(), 'test.flaky': fixtureJob(), 'test.broken': fixtureJob() },
  // The real scheduled jobs, whose handlers the worker module always provides.
  scheduled: SCHEDULED_JOBS,
};

/** What the fixture handlers saw, by job id. */
const calls: { name: string; id: string; attempt: number; tenantId?: string }[] = [];
const deadLetters: string[] = [];

@Injectable()
@HandlesJob('test.ok')
class OkHandler implements JobHandler<Payload> {
  handle(p: Payload, ctx: JobContext): Promise<void> {
    calls.push({ name: 'test.ok', id: p.id, attempt: ctx.attempt, tenantId: requestContext.getStore()?.tenantId });
    return Promise.resolve();
  }
}

@Injectable()
@HandlesJob('test.flaky')
class FlakyHandler implements JobHandler<Payload> {
  handle(p: Payload, ctx: JobContext): Promise<void> {
    calls.push({ name: 'test.flaky', id: p.id, attempt: ctx.attempt });
    return ctx.attempt === 1 ? Promise.reject(new Error('first attempt fails')) : Promise.resolve();
  }
}

@Injectable()
@HandlesJob('test.broken')
class BrokenHandler implements JobHandler<Payload> {
  handle(p: Payload, ctx: JobContext): Promise<void> {
    calls.push({ name: 'test.broken', id: p.id, attempt: ctx.attempt });
    return Promise.reject(new Error('always fails'));
  }

  onDeadLetter(p: Payload): Promise<void> {
    deadLetters.push(p.id);
    return Promise.resolve();
  }
}

const handlers = [OkHandler, FlakyHandler, BrokenHandler];

describe('job worker', () => {
  let worker: TestingModule | undefined;
  let jobs: JobsService;
  const lines: string[] = [];
  const reporter = { report: jest.fn() };
  const previousLevel = process.env.LOG_LEVEL;

  const enqueue = (name: string, p: Payload) =>
    jobs.enqueue(name as JobName, p as Parameters<JobsService['enqueue']>[1]);
  const callsFor = (id: string) => calls.filter((call) => call.id === id);

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    // The e2e default is warn; job lines for completed attempts are info.
    process.env.LOG_LEVEL = 'info';
    worker = await startTestWorker(
      (builder) =>
        builder
          .overrideProvider(JOB_REGISTRY)
          .useValue(fixture)
          .overrideProvider(LOG_DESTINATION)
          .useValue({ write: (line: string) => lines.push(line) })
          .overrideProvider(ERROR_REPORTER)
          .useValue(reporter),
      handlers,
    );
    jobs = worker.get(JobsService);
  });

  afterAll(async () => {
    process.env.LOG_LEVEL = previousLevel;
    if (worker) {
      await worker.get(JobsService).queue('maintenance').obliterate({ force: true });
      await worker.close();
    }
  });

  it('runs a job in the worker', async () => {
    const id = newId();
    await enqueue('test.ok', { id });

    await waitFor(async () => callsFor(id)[0]);
    expect(callsFor(id)).toEqual([expect.objectContaining({ name: 'test.ok', attempt: 1 })]);
  });

  it('retries with backoff and then succeeds', async () => {
    const id = newId();
    await enqueue('test.flaky', { id });

    await waitFor(async () => (callsFor(id).length === 2 ? true : undefined));
    // Completed jobs are removed at once (J1).
    await waitFor(async () => ((await jobs.queue('maintenance').getJob(`test.flaky/${id}`)) ? undefined : true));
    expect(callsFor(id).map((call) => call.attempt)).toEqual([1, 2]);
  });

  it('dead-letters after the last attempt and calls onDeadLetter once', async () => {
    const id = newId();
    reporter.report.mockClear();
    await enqueue('test.broken', { id });

    const job = await waitFor(async () => {
      const candidate = await jobs.queue('maintenance').getJob(`test.broken/${id}`);
      return (await candidate?.getState()) === 'failed' ? candidate : undefined;
    });

    expect(job.failedReason).toBe('always fails');
    expect(callsFor(id)).toHaveLength(3);
    expect(deadLetters.filter((dead) => dead === id)).toHaveLength(1);
    expect(reporter.report).toHaveBeenCalledTimes(1);
    expect(reporter.report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ jobId: `test.broken/${id}`, jobName: 'test.broken' }),
    );
  });

  it('an invalid payload dead-letters without running the handler', async () => {
    const jobId = `test.ok/invalid-${newId()}`;
    await jobs.queue('maintenance').add('test.ok', { id: 'not-a-uuid' }, { jobId, attempts: 3 });

    const job = await waitFor(async () => {
      const candidate = await jobs.queue('maintenance').getJob(jobId);
      return (await candidate?.getState()) === 'failed' ? candidate : undefined;
    });

    // Unrecoverable: started once, never retried. (BullMQ 6 does not count an
    // unrecoverable failure in attemptsMade, so count the starts instead.)
    expect(job.failedReason).toBe('Invalid payload for test.ok');
    expect(job.attemptsStarted).toBe(1);
    expect(calls.some((call) => call.id === 'not-a-uuid')).toBe(false);
  });

  it('logs id, name, attempt and duration, and never the payload', async () => {
    const id = newId();
    await enqueue('test.ok', { id, note: 'secret-marker' });
    await waitFor(async () => callsFor(id)[0]);

    const entry = await waitFor(async () =>
      lines
        .map((line) => JSON.parse(line) as { job?: Record<string, unknown> })
        .find((candidate) => candidate.job?.id === `test.ok/${id}`),
    );

    expect(entry.job).toEqual({
      id: `test.ok/${id}`,
      name: 'test.ok',
      queue: 'maintenance',
      attempt: 1,
      durationMs: expect.any(Number),
      outcome: 'completed',
    });
    expect(lines.join('\n')).not.toContain('secret-marker');
  });

  it('carries the tenant into the request context', async () => {
    const id = newId();
    const tenantId = newId();
    await enqueue('test.ok', { id, tenantId });

    const call = await waitFor(async () => callsFor(id)[0]);
    expect(call.tenantId).toBe(tenantId);
  });

  it('refuses to boot when a registry job has no handler', async () => {
    const orphaned: JobRegistry = { jobs: { ...fixture.jobs, 'test.orphan': fixtureJob() }, scheduled: SCHEDULED_JOBS };

    await expect(
      startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(orphaned), handlers),
    ).rejects.toThrow(/test\.orphan has no handler/);
  });
});
