import type { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { BrandProfileService } from '../modules/ai/customer-tools/brand-profile.service';
import type { ArticlesService } from '../modules/ai/knowledge/articles.service';
import type { CustomerAuth, TenantAuth } from '../modules/identity/auth-context';
import { TENANT_PERMISSIONS } from '../modules/identity/permissions';
import type { PlanFeature } from '../modules/payments/plans/plans';
import type { PlansService } from '../modules/payments/plans/plans.service';

// The demo workspace's AI: a monthly limit so the dashboard's briefing and Cmd+K work, three knowledge
// articles for Cmd+K to answer from, matching the demo's partners and cast parts, and the customer AI
// tools on the paid plans with a brand profile for the first demo customer.

const DAY_MS = 86_400_000;
const LIMIT_USD = '20.00';

const ARTICLES = [
  {
    title: 'Handling a failed casting QC',
    tags: ['casting', 'qc'],
    body: [
      'When a cast piece fails its QC check, record the defect on the piece before anything else, so the defect rate on the dashboard stays true.',
      '',
      'Porosity, short fills and cracks go back to casting: send the piece back to casting with the defect noted, and the partner recasts it at their cost.',
      '',
      'Surface marks that polishing can remove go on to finishing. If the same defect shows on more than two pieces of one job, review the partner before offering them the next cast job.',
    ].join('\n'),
  },
  {
    title: 'Offering a job to a partner',
    tags: ['partners', 'jobs'],
    body: [
      'Offer a job to a partner who has the step type and room this week. The dashboard lists partners at 90 % of their capacity or more; avoid those.',
      '',
      'An offer the partner has not answered within a day shows under "Needs attention". Call the partner, or withdraw the offer and offer the job to another partner with room.',
      '',
      'Check the partner’s on-time rate on the dashboard first: for a rush order, prefer the partner who delivers on time.',
    ].join('\n'),
  },
  {
    title: 'Chasing an overdue invoice',
    tags: ['payments', 'invoices'],
    body: [
      'An invoice past its due date shows under "Needs attention", and the customer has already had an automatic reminder.',
      '',
      'Call the customer’s billing contact first and agree a date. If the invoice is still open a week later, hold new pay-later orders by lowering the customer’s credit limit.',
      '',
      'Customers paying late more than once show among the slow payers on the dashboard; consider moving them to pay first.',
    ].join('\n'),
  },
];

/** The paid plans of the demo (`seed-plans.ts`) that get the customer AI tools. */
const AI_PLANS = ['pro', 'business'];
const AI_SWITCHES: PlanFeature[] = ['ai_recommendations', 'ai_marketing', 'ai_brand', 'ai_images'];

/** The brand profile of the demo's first customer, a maker of silver jewellery. */
const PROFILE = {
  name: 'Luna Jewels',
  sells: 'Hand-finished silver rings and pendants, made to order',
  audience: 'People buying a first piece of fine jewellery, or a gift',
  tone: 'Warm, plain and unhurried',
  notes: 'No gemstones. Every piece is cast in recycled silver.',
};

export interface AiSeedCounts {
  /** 1 when the workspace was given its demo limit. */
  limit: number;
  articles: number;
  /** Paid plans given the AI switches they were missing. */
  plans: number;
  /** 1 when the first customer was given the demo brand profile. */
  profiles: number;
}

/**
 * Seeds the demo AI into one workspace: a monthly limit of 20.00 USD unless one is set, three published
 * articles through `ArticlesService` (publishing queues their indexing), the four customer AI switches
 * on the paid plans through `PlansService`, and the demo brand profile for the oldest customer through
 * `BrandProfileService`; each audited as `actorUserId`. Idempotent: an article is found by title,
 * whatever its status; a plan gets only the switches it lacks; a customer with a profile keeps it.
 */
export async function seedAi(
  deps: { prisma: PrismaService; articles: ArticlesService; plans: PlansService; profiles: BrandProfileService },
  tenantId: string,
  actorUserId: string,
): Promise<AiSeedCounts> {
  const { prisma } = deps;
  const auth: TenantAuth = {
    scope: 'tenant',
    tenantId,
    userId: actorUserId,
    jti: 'seed',
    expiresAt: new Date(Date.now() + DAY_MS),
    permissions: new Set(TENANT_PERMISSIONS),
  };
  const created: AiSeedCounts = { limit: 0, articles: 0, plans: 0, profiles: 0 };

  const existing = await prisma.inTenant(tenantId, async (tx) => {
    const limit = await tx.tenant.updateMany({
      where: { id: tenantId, aiMonthlyLimitUsd: null },
      data: { aiMonthlyLimitUsd: new Prisma.Decimal(LIMIT_USD) },
    });
    created.limit = limit.count;
    const first = await tx.customer.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, aiBrandProfile: { select: { id: true } } } });
    return {
      articles: await tx.knowledgeArticle.findMany({ where: { title: { in: ARTICLES.map((one) => one.title) } }, select: { title: true } }),
      plans: await tx.plan.findMany({ where: { key: { in: AI_PLANS } }, orderBy: { position: 'asc' }, select: { id: true, features: true } }),
      customer: first && !first.aiBrandProfile ? first.id : null,
    };
  });

  for (const article of ARTICLES) {
    if (existing.articles.some((one) => one.title === article.title)) continue;
    const draft = await deps.articles.create(auth, { ...article, attachment_file_ids: [] });
    await deps.articles.publish(auth, draft.id);
    created.articles += 1;
  }

  for (const plan of existing.plans) {
    const features = plan.features as PlanFeature[];
    const missing = AI_SWITCHES.filter((feature) => !features.includes(feature));
    if (missing.length === 0) continue;
    await deps.plans.update(auth, plan.id, { features: [...features, ...missing] });
    created.plans += 1;
  }

  if (existing.customer) {
    const customer: CustomerAuth = { tenantId, userId: actorUserId, customerId: existing.customer, role: 'owner' };
    await deps.profiles.save(customer, PROFILE);
    created.profiles = 1;
  }
  return created;
}
