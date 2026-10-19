import { randomBytes } from 'node:crypto';
import { INestApplication, Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { HandlesJob, JobHandler } from '../src/jobs/handles-job';
import { JobsService } from '../src/jobs/jobs.service';
import { defineJob, JOB_REGISTRY, JobName, JobRegistry, JOBS, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { hashPassword } from '../src/modules/identity/passwords';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

/** Fails while `failing` is set, so a job can be dead-lettered and then retried successfully. */
const state = { failing: true, runs: [] as string[] };

@Injectable()
@HandlesJob('test.flip')
class FlipHandler implements JobHandler<{ id: string }> {
  handle(payload: { id: string }): Promise<void> {
    state.runs.push(payload.id);
    return state.failing ? Promise.reject(new Error('still failing')) : Promise.resolve();
  }
}

const fixture: JobRegistry = {
  jobs: {
    // The real jobs too: the worker module always provides their handlers.
    ...JOBS,
    'test.flip': defineJob({
      queue: 'maintenance',
      payload: z.object({ id: z.uuid() }),
      jobId: (p) => [p.id],
      attempts: 1,
      backoffMs: 10,
    }),
  },
  scheduled: SCHEDULED_JOBS,
};

interface FailedJob {
  queue: string;
  id: string;
  name: string;
  data: unknown;
  failed_reason: string;
  attempts_made: number;
  failed_at: string;
}

describe('platform jobs', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let jobs: JobsService;
  let adminId: string;
  let adminToken: string;
  let tenantToken: string;
  const createdTenants: string[] = [];

  const get = (path: string, token = adminToken) =>
    request(app.getHttpServer()).get(`/platform/jobs/${path}`).set('Authorization', `Bearer ${token}`);
  const post = (path: string, token = adminToken) =>
    request(app.getHttpServer()).post(`/platform/jobs/${path}`).set('Authorization', `Bearer ${token}`);

  /** A job id contains '/', so it travels URL-encoded in the path. */
  const retryPath = (jobId: string) => `failed/maintenance/${encodeURIComponent(jobId)}/retry`;

  async function deadLetteredJob(): Promise<string> {
    const id = newId();
    const jobId = `test.flip/${id}`;
    await jobs.enqueue('test.flip' as JobName, { id } as unknown as Parameters<JobsService['enqueue']>[1]);
    await waitFor(async () => ((await (await jobs.queue('maintenance').getJob(jobId))?.getState()) === 'failed' ? true : undefined));
    return jobId;
  }

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOB_REGISTRY)
      .useValue(fixture)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jobs = moduleRef.get(JobsService);

    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture), [FlipHandler]);

    const tokens = moduleRef.get(AccessTokenService);
    const admin = await prisma.platformAdmin.create({
      data: { email: `jobs-${newId()}@example.test`, passwordHash: await hashPassword('platform-admin-password'), name: 'Jobs Admin' },
    });
    adminId = admin.id;
    adminToken = (await tokens.issueForPlatformAdmin(admin.id)).accessToken;

    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    tenantToken = (await tokens.issueForUser(tenant.id, owner.id)).accessToken;
  });

  afterAll(async () => {
    await jobs?.queue('maintenance').obliterate({ force: true });
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await prisma?.platformAdmin.delete({ where: { id: adminId } });
    await app?.close();
  });

  beforeEach(() => {
    state.failing = true;
  });

  it('counts per queue include the failed job', async () => {
    await deadLetteredJob();

    const response = await get('queues').expect(200);
    const queues = (response.body as { data: { queue: string; failed: number }[] }).data;

    expect(queues.map((entry) => entry.queue).sort()).toEqual(['files', 'maintenance', 'notifications']);
    expect(queues.find((entry) => entry.queue === 'maintenance')).toEqual({
      queue: 'maintenance',
      waiting: expect.any(Number),
      active: expect.any(Number),
      delayed: expect.any(Number),
      failed: expect.any(Number),
    });
    expect(queues.find((entry) => entry.queue === 'maintenance')?.failed).toBeGreaterThanOrEqual(1);
  });

  it('lists the failed job with its reason, newest first', async () => {
    const older = await deadLetteredJob();
    const newer = await deadLetteredJob();

    const response = await get('failed?queue=maintenance').expect(200);
    const failed = (response.body as { data: FailedJob[] }).data;
    const ids = failed.map((job) => job.id);

    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    expect(failed.find((job) => job.id === newer)).toEqual({
      queue: 'maintenance',
      id: newer,
      name: 'test.flip',
      data: { id: newer.split('/')[1] },
      failed_reason: 'still failing',
      attempts_made: 1,
      failed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('pages with limit and offset, and rejects an unknown queue', async () => {
    await deadLetteredJob();
    await deadLetteredJob();

    const first = await get('failed?queue=maintenance&limit=1').expect(200);
    const second = await get('failed?queue=maintenance&limit=1&offset=1').expect(200);
    const [a] = (first.body as { data: FailedJob[] }).data;
    const [b] = (second.body as { data: FailedJob[] }).data;
    expect(a?.id).toBeDefined();
    expect(b?.id).toBeDefined();
    expect(a?.id).not.toBe(b?.id);

    await get('failed?queue=unknown').expect(400);
    await get('failed?queue=maintenance&limit=500').expect(400);
  });

  it('retry moves it back to waiting with attempts reset, and it runs', async () => {
    const jobId = await deadLetteredJob();
    state.failing = false;
    const runsBefore = state.runs.length;

    await post(retryPath(jobId)).expect(204);

    // It ran once more and completed; completed jobs are removed (J1).
    await waitFor(async () => ((await jobs.queue('maintenance').getJob(jobId)) ? undefined : true));
    expect(state.runs.length).toBe(runsBefore + 1);

    const failed = (await get('failed?queue=maintenance').expect(200)).body as { data: FailedJob[] };
    expect(failed.data.some((job) => job.id === jobId)).toBe(false);
  });

  it('retry gives 404 for a job that is not in the failed set', async () => {
    await post(retryPath(`test.flip/${newId()}`)).expect(404);
    await post('failed/unknown/some-id/retry').expect(400);
  });

  it('a tenant token gets 403 on all three', async () => {
    await get('queues', tenantToken).expect(403);
    await get('failed?queue=maintenance', tenantToken).expect(403);
    await post(retryPath(`test.flip/${newId()}`), tenantToken).expect(403);
  });
});
