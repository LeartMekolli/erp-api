import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedAi } from '../src/cli/seed-ai';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { ArticlesService } from '../src/modules/ai/knowledge/articles.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const TITLES = ['Handling a failed casting QC', 'Offering a job to a partner', 'Chasing an overdue invoice'];

/** The AI demo seed (AI 1 plan, Task 9): a $20 limit and three published articles. Idempotent. */
describe('ai demo seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdTenants: string[] = [];

  const deps = () => ({ prisma, articles: app.get(ArticlesService) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    return { id: tenant.id, ownerId: owner.id };
  }

  it('sets a $20 limit and publishes three articles, once', async () => {
    const w = await workspace();

    expect(await seedAi(deps(), w.id, w.ownerId)).toEqual({ limit: 1, articles: 3 });
    expect(await seedAi(deps(), w.id, w.ownerId)).toEqual({ limit: 0, articles: 0 });

    const { tenant, articles } = await prisma.inTenant(w.id, async (tx) => ({
      tenant: await tx.tenant.findUniqueOrThrow({ where: { id: w.id }, select: { aiMonthlyLimitUsd: true } }),
      articles: await tx.knowledgeArticle.findMany({ orderBy: { title: 'asc' }, select: { title: true, status: true, body: true } }),
    }));
    expect(tenant.aiMonthlyLimitUsd?.toFixed(2)).toBe('20.00');
    expect(articles.map((one) => one.title)).toEqual([...TITLES].sort());
    for (const article of articles) {
      expect(article.status).toBe('published');
      expect(article.body.length).toBeGreaterThan(100);
    }
    // Every change audited as the actor.
    const audited = await prisma.inTenant(w.id, (tx) => tx.auditEntry.count({ where: { action: 'knowledge.changed', actorId: w.ownerId } }));
    expect(audited).toBe(6);
  });

  it('keeps a limit already set, and an article staff have changed', async () => {
    const w = await workspace();
    await prisma.inTenant(w.id, (tx) => tx.tenant.update({ where: { id: w.id }, data: { aiMonthlyLimitUsd: new Prisma.Decimal('5.00') } }));
    await seedAi(deps(), w.id, w.ownerId);
    await prisma.inTenant(w.id, (tx) =>
      tx.knowledgeArticle.updateMany({ where: { title: TITLES[0] }, data: { body: 'Our own way.', status: 'archived' } }),
    );

    expect(await seedAi(deps(), w.id, w.ownerId)).toEqual({ limit: 0, articles: 0 });

    const { tenant, first } = await prisma.inTenant(w.id, async (tx) => ({
      tenant: await tx.tenant.findUniqueOrThrow({ where: { id: w.id }, select: { aiMonthlyLimitUsd: true } }),
      first: await tx.knowledgeArticle.findFirstOrThrow({ where: { title: TITLES[0] } }),
    }));
    expect(tenant.aiMonthlyLimitUsd?.toFixed(2)).toBe('5.00');
    expect(first).toMatchObject({ body: 'Our own way.', status: 'archived' });
  });
});
