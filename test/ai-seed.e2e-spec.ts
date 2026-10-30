import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedAi } from '../src/cli/seed-ai';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { BrandProfileService } from '../src/modules/ai/customer-tools/brand-profile.service';
import { ArticlesService } from '../src/modules/ai/knowledge/articles.service';
import { PlansService } from '../src/modules/payments/plans/plans.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const TITLES = ['Handling a failed casting QC', 'Offering a job to a partner', 'Chasing an overdue invoice'];
const AI_SWITCHES = ['ai_recommendations', 'ai_marketing', 'ai_brand', 'ai_images'];

/**
 * The AI demo seed (AI 1 plan, Task 9; AI 2 plan, Task 7): a $20 limit, three published articles, the
 * four AI switches on the paid plans and a brand profile for the first customer. Idempotent.
 */
describe('ai demo seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdTenants: string[] = [];

  const deps = () => ({ prisma, articles: app.get(ArticlesService), plans: app.get(PlansService), profiles: app.get(BrandProfileService) });

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

  /** As the demo has them by then: Starter, Pro (with progress emails) and Business, and two customers. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const customers = await prisma.inTenant(tenant.id, async (tx) => {
      const { defaultCurrency: currency } = await tx.tenant.findFirstOrThrow({ select: { defaultCurrency: true } });
      await tx.plan.create({ data: { key: 'pro', name: 'Pro', position: 1, currency, features: ['progress_emails'] } });
      await tx.plan.create({ data: { key: 'business', name: 'Business', position: 2, currency } });
      const first = await tx.customer.create({ data: { name: 'Luna Jewels' } });
      const second = await tx.customer.create({ data: { name: 'Mira Studio' } });
      return { first: first.id, second: second.id };
    });
    return { id: tenant.id, ownerId: owner.id, ...customers };
  }

  it('turns on the AI tools on the paid plans and gives the first customer a brand profile, once', async () => {
    const w = await workspace();

    expect(await seedAi(deps(), w.id, w.ownerId)).toEqual({ limit: 1, articles: 3, plans: 2, profiles: 1 });
    expect(await seedAi(deps(), w.id, w.ownerId)).toEqual({ limit: 0, articles: 0, plans: 0, profiles: 0 });

    const { plans, profiles } = await prisma.inTenant(w.id, async (tx) => ({
      plans: await tx.plan.findMany({ select: { key: true, features: true } }),
      profiles: await tx.aiBrandProfile.findMany(),
    }));
    const features = (key: string) => plans.find((plan) => plan.key === key)!.features;
    expect(features('pro')).toEqual(['progress_emails', ...AI_SWITCHES]);
    expect(features('business')).toEqual(AI_SWITCHES);
    expect(features('starter').filter((feature) => feature.startsWith('ai_'))).toEqual([]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ customerId: w.first, name: 'Luna Jewels' });
    // Both audited as the actor.
    const audited = await prisma.inTenant(w.id, async (tx) => ({
      plans: await tx.auditEntry.count({ where: { action: 'plan.changed', actorId: w.ownerId } }),
      profiles: await tx.auditEntry.count({ where: { action: 'brand_profile.changed', actorId: w.ownerId } }),
    }));
    expect(audited).toEqual({ plans: 2, profiles: 1 });
  });

  it('keeps a plan staff have changed, and a profile the customer has written', async () => {
    const w = await workspace();
    await prisma.inTenant(w.id, async (tx) => {
      await tx.plan.updateMany({ where: { key: 'pro' }, data: { features: ['ai_images'] } });
      await tx.aiBrandProfile.create({
        data: { customerId: w.first, name: 'Our own', sells: 'Rings', audience: 'Everyone', tone: 'Plain', updatedByUserId: w.ownerId },
      });
    });

    expect(await seedAi(deps(), w.id, w.ownerId)).toMatchObject({ plans: 2, profiles: 0 });

    const { pro, profile } = await prisma.inTenant(w.id, async (tx) => ({
      pro: await tx.plan.findFirstOrThrow({ where: { key: 'pro' } }),
      profile: await tx.aiBrandProfile.findFirstOrThrow({ where: { customerId: w.first } }),
    }));
    // A switch staff turned off on purpose can't be told from one never set: missing ones are added.
    expect([...pro.features].sort()).toEqual([...AI_SWITCHES].sort());
    expect(profile.name).toBe('Our own');
  });

  it('sets a $20 limit and publishes three articles, once', async () => {
    const w = await workspace();

    expect(await seedAi(deps(), w.id, w.ownerId)).toMatchObject({ limit: 1, articles: 3 });
    expect(await seedAi(deps(), w.id, w.ownerId)).toMatchObject({ limit: 0, articles: 0 });

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

    expect(await seedAi(deps(), w.id, w.ownerId)).toMatchObject({ limit: 0, articles: 0 });

    const { tenant, first } = await prisma.inTenant(w.id, async (tx) => ({
      tenant: await tx.tenant.findUniqueOrThrow({ where: { id: w.id }, select: { aiMonthlyLimitUsd: true } }),
      first: await tx.knowledgeArticle.findFirstOrThrow({ where: { title: TITLES[0] } }),
    }));
    expect(tenant.aiMonthlyLimitUsd?.toFixed(2)).toBe('5.00');
    expect(first).toMatchObject({ body: 'Our own way.', status: 'archived' });
  });
});
