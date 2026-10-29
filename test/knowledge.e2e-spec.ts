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
import { AI_PROVIDER } from '../src/modules/ai/ai-provider';
import { fakeToolUse } from '../src/modules/ai/fake-ai-provider';
import type { FakeAiProvider } from '../src/modules/ai/fake-ai-provider';
import { articleListResponseSchema, articleResponseSchema } from '../src/modules/ai/knowledge/article-response';
import type { FakeVectorStore } from '../src/modules/ai/knowledge/fake-vector-store';
import { VECTOR_STORE, namespaceOf } from '../src/modules/ai/knowledge/vector-store';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { STORAGE } from '../src/storage/object-storage';
import type { ObjectStorage } from '../src/storage/object-storage';
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { putToSignedUrl } from './storage';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface Article {
  id: string;
  title: string;
  status: string;
  attachments: { file_id: string; name: string; content_type: string }[];
}
interface Run {
  status: string;
  answer: { text: string; refs: { type: string; id: string; label: string }[] } | null;
}

const fixture: JobRegistry = {
  jobs: { ...JOBS, 'ai.run': { ...JOBS['ai.run'], backoffMs: 10 }, 'knowledge.index': { ...JOBS['knowledge.index'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};
const ATTACHMENT_TEXT = 'Weigh every recast piece and note the weight on the job.';

/** A knowledge base staff write, searched through the vector store (AI 1 plan, Task 6). */
describe('ai: the knowledge base', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let storage: ObjectStorage;
  let ai: FakeAiProvider;
  let store: FakeVectorStore;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });
  type Client = ReturnType<typeof as>;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JOB_REGISTRY).useValue(fixture).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    storage = app.get<ObjectStorage>(STORAGE);
    worker = await startTestWorker((builder) => builder.overrideProvider(JOB_REGISTRY).useValue(fixture));
    // Indexing and asking run in the worker, so its fakes hold the passages and answer.
    ai = worker.get<FakeAiProvider>(AI_PROVIDER);
    store = worker.get<FakeVectorStore>(VECTOR_STORE);
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  /** A workspace with a $5 AI limit, its owner (who writes) and a member (who doesn't). */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    await prisma.inTenant(tenant.id, (tx) =>
      tx.tenant.update({ where: { id: tenant.id }, data: { aiMonthlyLimitUsd: new Prisma.Decimal('5.00') } }),
    );
    return {
      id: tenant.id,
      ownerId: owner.id,
      owner: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
    };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  /** A plain text file, uploaded to storage as a client would. */
  async function textFile(w: Workspace, text: string): Promise<string> {
    const body = Buffer.from(text);
    const storageKey = `test/${w.id}/${newId()}`;
    const { url, headers } = await storage.presignPut(storageKey, { contentType: 'text/plain', contentLength: body.length, expiresInSeconds: 60 });
    expect((await putToSignedUrl(url, body, headers)).ok).toBe(true);
    return prisma.inTenant(w.id, async (tx) => {
      const file = await tx.file.create({ data: { kind: 'document', name: 'recast.txt', createdByUserId: w.ownerId } });
      await tx.fileVersion.create({
        data: {
          fileId: file.id,
          number: 1,
          storageKey,
          originalName: 'recast.txt',
          contentType: 'text/plain',
          size: body.length,
          status: 'uploaded',
          uploadedByUserId: w.ownerId,
          completedAt: new Date(),
        },
      });
      return file.id;
    });
  }

  const articleBody = (extra: object = {}) => ({
    title: 'Handling a failed casting QC',
    body: 'When a casting fails QC, send the piece back to casting.\n\nRecord the defect on the move.',
    tags: ['casting', 'qc'],
    attachment_file_ids: [],
    ...extra,
  });
  const create = async (w: Workspace, extra: object = {}) =>
    (await w.owner.post('/knowledge/articles', articleBody(extra)).expect(201)).body as Article;
  const listed = async (client: Client, query = '') =>
    ((await client.get(`/knowledge/articles${query}`).expect(200)).body as { data: { id: string }[] }).data.map((one) => one.id);
  const indexed = (w: Workspace, articleId: string, present: boolean) =>
    waitFor(async () => {
      const passages = store.passagesOf(namespaceOf(w.id), articleId);
      return (passages.length > 0) === present ? passages : undefined;
    });
  const askAbout = async (w: Workspace, query: string, articleId: string) => {
    const before = ai.calls.length;
    ai.script(
      fakeToolUse('search_knowledge', { query }, 'call_search'),
      fakeToolUse('answer', { text: 'Send it back to casting.', refs: [{ type: 'article', id: articleId }], action: null }),
    );
    const id = ((await w.owner.post('/ai/ask', { question: `How do we handle a ${query}?` }).expect(202)).body as { id: string }).id;
    const run = await waitFor(async () => {
      const one = (await w.owner.get(`/ai/runs/${id}`).expect(200)).body as Run;
      return one.status === 'pending' ? undefined : one;
    });
    return { run, toolResult: JSON.stringify(ai.calls[before + 1].messages.at(-1)) };
  };

  it('keeps a draft from staff who do not write, indexes it once published, and answers from it, cited', async () => {
    const w = await workspace();
    const attachment = await textFile(w, ATTACHMENT_TEXT);

    const draft = await create(w, { attachment_file_ids: [attachment] });
    expectDocumented(articleResponseSchema, draft);
    expect(draft).toMatchObject({ status: 'draft', attachments: [{ file_id: attachment, name: 'recast.txt', content_type: 'text/plain' }] });
    expect(await listed(w.member)).not.toContain(draft.id);
    await w.member.get(`/knowledge/articles/${draft.id}`).expect(404);
    await w.member.post('/knowledge/articles', articleBody()).expect(403);
    expect(store.passagesOf(namespaceOf(w.id), draft.id)).toEqual([]);

    const published = await w.owner.post(`/knowledge/articles/${draft.id}/publish`).expect(200);
    expectDocumented(articleResponseSchema, published.body);
    const passages = await indexed(w, draft.id, true);
    expect(passages.map((one) => one.text).join('\n')).toContain(ATTACHMENT_TEXT);

    const list = await w.member.get('/knowledge/articles?q=casting').expect(200);
    expectDocumented(articleListResponseSchema, list.body);
    expect((list.body as { data: { id: string }[] }).data.map((one) => one.id)).toEqual([draft.id]);
    await w.member.get(`/knowledge/articles/${draft.id}`).expect(200);

    const { run, toolResult } = await askAbout(w, 'failed casting QC', draft.id);
    expect(toolResult).toContain('send the piece back to casting');
    expect(run.status).toBe('done');
    expect(run.answer?.refs).toEqual([{ type: 'article', id: draft.id, label: 'Handling a failed casting QC' }]);
  });

  it('reindexes an edit of a published article, and removes it from the store when archived', async () => {
    const w = await workspace();
    const article = await create(w);
    await w.owner.post(`/knowledge/articles/${article.id}/publish`).expect(200);
    await indexed(w, article.id, true);

    await w.owner.patch(`/knowledge/articles/${article.id}`, { body: 'Melt it down and recast.' }).expect(200);
    await waitFor(async () =>
      store.passagesOf(namespaceOf(w.id), article.id).some((one) => one.text.includes('Melt it down')) ? true : undefined,
    );

    const archived = await w.owner.post(`/knowledge/articles/${article.id}/archive`).expect(200);
    expect((archived.body as Article).status).toBe('archived');
    await indexed(w, article.id, false);
    expect(await listed(w.member)).not.toContain(article.id);

    const audited = await prisma.inTenant(w.id, (tx) => tx.auditEntry.findMany({ where: { action: 'knowledge.changed', subjectId: article.id } }));
    expect(audited).toHaveLength(4);
  });

  it('refuses an attachment that is not PDF or plain text, and a file of another workspace', async () => {
    const w = await workspace();
    const other = await workspace();
    const design = await measuredDesign(prisma, w.id, w.ownerId);
    const foreign = await textFile(other, 'Not yours.');

    await w.owner.post('/knowledge/articles', articleBody({ attachment_file_ids: [design.fileId] })).expect(400);
    await w.owner.post('/knowledge/articles', articleBody({ attachment_file_ids: [foreign] })).expect(400);
    await w.owner.post('/knowledge/articles', articleBody({ title: '' })).expect(400);
  });

  it("never finds one workspace's article from another (Review Focus 4)", async () => {
    const a = await workspace();
    const b = await workspace();
    const article = await create(a);
    await a.owner.post(`/knowledge/articles/${article.id}/publish`).expect(200);
    await indexed(a, article.id, true);

    expect(await listed(b.owner, '?q=casting')).toEqual([]);
    await b.owner.get(`/knowledge/articles/${article.id}`).expect(404);

    const { run, toolResult } = await askAbout(b, 'failed casting QC', article.id);
    expect(toolResult).not.toContain('send the piece back to casting');
    // The article was never returned in B, so the citation is dropped.
    expect(run.answer?.refs).toEqual([]);
  });
});
