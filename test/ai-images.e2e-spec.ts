import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { costOf } from '../src/modules/ai/ai-models';
import { AI_PROVIDER } from '../src/modules/ai/ai-provider';
import { customerResultSchema, startedSchema } from '../src/modules/ai/customer-tools/customer-result-response';
import { FOR_3D } from '../src/modules/ai/customer-tools/images';
import { imageCost } from '../src/modules/ai/extra-costs';
import { fakeToolUse } from '../src/modules/ai/fake-ai-provider';
import type { FakeAiProvider } from '../src/modules/ai/fake-ai-provider';
import type { FakeImageProvider } from '../src/modules/ai/fake-image-provider';
import { IMAGE_PROVIDER } from '../src/modules/ai/image-provider';
import { FilesService } from '../src/modules/files/files.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

const PASSWORD = 'a-long-customer-password';
const DAY_MS = 86_400_000;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
/** What one fake Claude call costs on Haiku 4.5: 100 tokens in, 50 out. */
const ONE_CALL = costOf('claude-haiku-4-5', { inputTokens: 100, outputTokens: 50 });

const fixture: JobRegistry = { jobs: { ...JOBS, 'ai.run': { ...JOBS['ai.run'], backoffMs: 10 } }, scheduled: SCHEDULED_JOBS };

interface Result {
  id: string;
  status: string;
  credits: number;
  credits_given_back: boolean;
  parent_id: string | null;
  file_id: string | null;
  output: { prompt: string; file_id: string } | null;
}

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
  };
}
type Client = ReturnType<typeof clientFor>;

/** Concept images made for 3D, refined step by step (AI 2 plan, Task 6). */
describe('ai: images and refinements', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let claude: FakeAiProvider;
  let images: FakeImageProvider;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;

  let tenantId: string;
  let luna: string;
  let sol: string;
  let anna: Client;
  let sam: Client;
  /** The first image, then its refinement, then the refinement of that. */
  const chain: string[] = [];

  /** A workspace with a 5.00 USD AI limit, images on the default plan at 4 credits; Luna and Sol have 20 each. */
  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOB_REGISTRY)
      .useValue(fixture)
      .overrideProvider(IDENTITY_NOTIFIER)
      .useValue(notifier)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
    // The run executes in the worker, so the worker's fakes answer.
    claude = worker.get<FakeAiProvider>(AI_PROVIDER);
    images = worker.get<FakeImageProvider>(IMAGE_PROVIDER);

    const tenant = await createTestTenant(prisma);
    tenantId = tenant.id;
    createdTenants.push(tenant.id);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.tenant.update({ where: { id: tenant.id }, data: { aiMonthlyLimitUsd: new Prisma.Decimal('5.00') } }),
    );
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, staffUser.id)).accessToken);
    const plans = (await staff.get('/payments/plans').expect(200)).body as { data: { id: string; is_default: boolean; features: string[] }[] };
    const starter = plans.data.find((plan) => plan.is_default)!;
    await staff.patch(`/payments/plans/${starter.id}`, { features: [...starter.features, 'ai_images'] }).expect(200);
    await staff.put('/settings/ai.toolPrices', { recommendations: 10, marketing: 5, brand_content: 3, image: 4 }).expect(200);

    const expiresOn = new Date(Date.now() + 30 * DAY_MS).toISOString().slice(0, 10);
    const customer = async (name: string) => {
      const id = ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
      await staff.post(`/payments/customers/${id}/credits`, { amount: 20, expires_on: expiresOn, reason: 'AI trial' }).expect(201);
      return id;
    };
    const owner = async (customerId: string, name: string) => {
      const email = `${name.toLowerCase()}-${newId()}@ai-images.example.test`;
      await staff.post(`/customers/${customerId}/invitations`, { email, role: 'owner' }).expect(201);
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send({ token: notifier.lastCustomerInvitationFor(email)!.token, name, password: PASSWORD })
        .expect(204);
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken);
    };
    luna = await customer('Luna Jewels');
    sol = await customer('Sol Rings');
    anna = await owner(luna, 'Anna');
    sam = await owner(sol, 'Sam');
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  const path = (customerId: string, rest: string) => `/portal/customers/${customerId}${rest}`;
  const balance = async (client: Client, customerId: string) =>
    ((await client.get(path(customerId, '/credits')).expect(200)).body as { total: number }).total;
  const finished = (id: string) =>
    waitFor(async () => {
      const body = (await anna.get(path(luna, `/ai/runs/${id}`)).expect(200)).body as Result;
      return body.status === 'pending' ? undefined : body;
    });
  /** Starts an image run as Anna and waits for it. */
  const image = async (written: string, body: object) => {
    claude.script(fakeToolUse('image_prompt', { prompt: written }));
    const started = await anna.post(path(luna, '/ai/images'), body).expect(202);
    expectDocumented(startedSchema, started.body);
    return finished((started.body as { id: string }).id);
  };
  /** The bytes of a customer's file, through the portal's download link. */
  const download = async (fileId: string) => {
    const detail = (await anna.get(path(luna, `/files/${fileId}`)).expect(200)).body as { versions: { id: string }[] };
    const link = (await anna.get(path(luna, `/files/${fileId}/versions/${detail.versions[0].id}/url`)).expect(200)).body as { url: string };
    return Buffer.from(await (await fetch(link.url)).arrayBuffer());
  };
  const costOfRun = async (runId: string) =>
    (await prisma.inTenant(tenantId, (tx) => tx.aiRunResult.findUniqueOrThrow({ where: { runId } }))).costUsd;

  it('makes an image for 3D from a description, saved as a file of the customer', async () => {
    const result = await image('A slim silver ring with a soft polish.', { description: 'a ring in a garden with a woman' });

    expectDocumented(customerResultSchema, result);
    expect(result).toMatchObject({ status: 'done', credits: 4, parent_id: null, file_id: result.id });
    expect(result.output).toEqual({ prompt: 'A slim silver ring with a soft polish.', file_id: result.id });
    chain.push(result.id);

    const bytes = await download(result.id);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    const made = images.calls.at(-1)!;
    expect(made.prompt.startsWith('A slim silver ring with a soft polish.')).toBe(true);
    expect(made.prompt.endsWith(FOR_3D)).toBe(true);
    expect(made.source).toBeUndefined();

    // Claude read the description as data; the run paid for Claude and the image.
    const call = claude.calls.at(-1)!;
    expect(call.messages[0].content as string).toMatch(/<customer_input>[\s\S]*a ring in a garden with a woman[\s\S]*<\/customer_input>/);
    expect(call.tools.map((tool) => tool.name)).toEqual(['image_prompt']);
    expect((await costOfRun(result.id)).toFixed(6)).toBe(ONE_CALL.add(imageCost('gpt-image-2.5-flare')).toFixed(6));
  });

  it('refines an image twice, each from the one before, editing its bytes', async () => {
    for (const change of ['thinner band', 'add a small star']) {
      const parent = chain.at(-1)!;
      const parentBytes = await download(parent);
      const result = await image(`The ring, with a ${change}.`, { description: change, from_id: parent });

      expect(result).toMatchObject({ status: 'done', credits: 4, parent_id: parent, file_id: result.id });
      expect(images.calls.at(-1)!.source?.equals(parentBytes)).toBe(true);
      const question = claude.calls.at(-1)!.messages[0].content as string;
      expect(question).toContain(change);
      expect(question).toContain((await finished(parent)).output!.prompt);
      chain.push(result.id);
    }

    expect(await balance(anna, luna)).toBe(8);
  });

  it("refuses another customer's image and a deleted one, and charges nothing (Review Focus 4)", async () => {
    const [, middle, last] = chain;

    await sam.post(path(sol, '/ai/images'), { description: 'thinner', from_id: middle }).expect(404);
    expect(await balance(sam, sol)).toBe(20);

    await anna.delete(path(luna, `/ai/results/${middle}`)).expect(204);
    await anna.get(path(luna, `/files/${middle}`)).expect(404);
    // The chain stays visible: the last refinement still names where it came from.
    expect((await finished(last)).parent_id).toBe(middle);
    await anna.get(path(luna, `/ai/runs/${middle}`)).expect(404);

    const refused = await anna.post(path(luna, '/ai/images'), { description: 'thinner', from_id: middle }).expect(409);
    expect(JSON.stringify(refused.body)).toContain('Image deleted');
    await anna.post(path(luna, '/ai/images'), { description: 'thinner', from_id: newId() }).expect(404);
    await anna.post(path(luna, '/ai/images'), { description: 'x'.repeat(1001) }).expect(400);
    await anna.post(path(luna, '/ai/images'), { description: 'thinner', from_id: 'not-an-id' }).expect(400);
    expect(await balance(anna, luna)).toBe(8);
  });

  it("fails without an image when the image provider fails, paying Claude only, and gives the credits back once (Review Focus 5)", async () => {
    images.fail(new Error('image service down'));
    const result = await image('A pendant.', { description: 'a pendant' });

    expect(result).toMatchObject({ status: 'failed', output: null, file_id: null });
    expect((await costOfRun(result.id)).toFixed(6)).toBe(ONE_CALL.toFixed(6));
    await waitFor(async () => ((await finished(result.id)).credits_given_back ? true : undefined));
    expect(await balance(anna, luna)).toBe(8);
    expect(await prisma.inTenant(tenantId, (tx) => tx.creditSpend.count({ where: { kind: 'give_back', customerId: luna } }))).toBe(1);
    expect(await prisma.inTenant(tenantId, (tx) => tx.file.count({ where: { id: result.id } }))).toBe(0);

    const refused = await anna.post(path(luna, '/ai/images'), { description: 'thinner', from_id: result.id }).expect(409);
    expect(JSON.stringify(refused.body)).toContain('Not finished');
  });

  it('fails without starting over when the image is made but cannot be stored, paying Claude and the image, and gives the credits back (review fix)', async () => {
    const before = await balance(anna, luna);
    const claudeCalls = claude.calls.length;
    const imageCalls = images.calls.length;
    const store = jest.spyOn(worker.get(FilesService), 'storeGenerated').mockRejectedValueOnce(new Error('storage down'));
    try {
      const result = await image('A pendant.', { description: 'a pendant' });

      expect(result).toMatchObject({ status: 'failed', output: null, file_id: null });
      // Neither provider was called again by a retried job.
      expect(claude.calls.length - claudeCalls).toBe(1);
      expect(images.calls.length - imageCalls).toBe(1);
      expect((await costOfRun(result.id)).toFixed(6)).toBe(ONE_CALL.add(imageCost('gpt-image-2.5-flare')).toFixed(6));
      await waitFor(async () => ((await finished(result.id)).credits_given_back ? true : undefined));
      expect(await balance(anna, luna)).toBe(before);
      expect(await prisma.inTenant(tenantId, (tx) => tx.file.count({ where: { id: result.id } }))).toBe(0);
    } finally {
      store.mockRestore();
    }
  });
});
