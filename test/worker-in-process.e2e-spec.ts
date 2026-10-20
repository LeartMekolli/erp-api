import { randomBytes } from 'node:crypto';
import { INestApplication, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { HandlesJob, JobHandler } from '../src/jobs/handles-job';
import { JobsService } from '../src/jobs/jobs.service';
import { defineJob, JOB_REGISTRY, JobName, JobRegistry, JOBS, SCHEDULED_JOBS } from '../src/jobs/registry';
import { RedisService } from '../src/redis/redis.service';
import { waitFor } from './wait-for';

type Payload = { id: string };
const payload = z.object({ id: z.uuid() });
const fixtureJob = () => defineJob({ queue: 'maintenance', payload, jobId: (p) => [p.id], attempts: 1, backoffMs: 10 });

const fixture: JobRegistry = {
  // The real jobs too: the worker module always provides their handlers.
  jobs: { ...JOBS, 'test.ok': fixtureJob(), 'test.slow': fixtureJob() },
  scheduled: SCHEDULED_JOBS,
};

/** Job ids the handlers started, and the order of events during shutdown. */
const seen: string[] = [];
const events: string[] = [];
let gate: Promise<void> = Promise.resolve();
let openGate: () => void = () => undefined;

@Injectable()
@HandlesJob('test.ok')
class OkHandler implements JobHandler<Payload> {
  handle(p: Payload): Promise<void> {
    seen.push(p.id);
    return Promise.resolve();
  }
}

@Injectable()
@HandlesJob('test.slow')
class SlowHandler implements JobHandler<Payload> {
  async handle(p: Payload): Promise<void> {
    seen.push(p.id);
    await gate;
    events.push('job done');
  }
}

describe('worker in the API process', () => {
  beforeEach(() => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    seen.length = 0;
    events.length = 0;
  });

  afterEach(() => jest.restoreAllMocks());

  async function boot(withWorker: boolean): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register({ withWorker })],
      providers: [OkHandler, SlowHandler],
    })
      .overrideProvider(JOB_REGISTRY)
      .useValue(fixture)
      .compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    return app;
  }

  const enqueue = (app: INestApplication, name: string, id: string) =>
    app.get(JobsService).enqueue(name as JobName, { id } as unknown as Parameters<JobsService['enqueue']>[1]);

  it('runs a job in the same process, answers HTTP, and registers the scheduled jobs', async () => {
    const app = await boot(true);
    try {
      const id = newId();
      await enqueue(app, 'test.ok', id);

      await waitFor(() => Promise.resolve(seen.includes(id) ? true : undefined));
      await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
      const schedulers = await app.get(JobsService).queue('maintenance').getJobSchedulers();
      expect(schedulers.map((scheduler) => scheduler.key)).toEqual(
        expect.arrayContaining(['claims.sweep', 'idempotency.cleanup']),
      );
    } finally {
      await app.get(JobsService).queue('maintenance').obliterate({ force: true });
      await app.close();
    }
  });

  it('only enqueues when the worker is off: the job stays queued', async () => {
    const app = await boot(false);
    try {
      const id = newId();
      await enqueue(app, 'test.ok', id);

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(seen).toEqual([]);
      expect(await app.get(JobsService).queue('maintenance').getJobCounts('waiting')).toEqual({ waiting: 1 });
    } finally {
      await app.get(JobsService).queue('maintenance').obliterate({ force: true });
      await app.close();
    }
  });

  it('closing waits for a running job before the pool and Redis go away', async () => {
    const app = await boot(true);
    gate = new Promise((resolve) => {
      openGate = resolve;
    });
    const prismaClose = PrismaService.prototype.onModuleDestroy;
    const redisClose = RedisService.prototype.onModuleDestroy;
    jest.spyOn(PrismaService.prototype, 'onModuleDestroy').mockImplementation(function (this: PrismaService) {
      events.push('database closed');
      return prismaClose.call(this);
    });
    jest.spyOn(RedisService.prototype, 'onModuleDestroy').mockImplementation(function (this: RedisService) {
      events.push('redis closed');
      return redisClose.call(this);
    });
    const id = newId();
    await enqueue(app, 'test.slow', id);
    await waitFor(() => Promise.resolve(seen.includes(id) ? true : undefined));

    const closing = app.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toEqual([]); // still waiting for the job
    openGate();
    await closing;

    expect(events[0]).toBe('job done');
    expect(events).toEqual(expect.arrayContaining(['database closed', 'redis closed']));
  });
});
