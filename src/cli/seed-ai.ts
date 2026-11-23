import { newId } from '../common/ids/uuid';
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
  /** Past Cmd+K runs written for the AI spend chart. */
  runs: number;
}

const QUESTIONS = ['Which orders are late?', 'What does Northcast Foundry owe?', 'Which customers pay slowly?', 'How many pieces failed final QC this week?'];
const RUN_MODEL = 'demo-model';

/** Mulberry32: a small seeded generator, so the same days give the same runs. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const MONTH_CAP_CENTS = 1_200;

/**
 * Past Cmd+K runs on about four days in five of the previous and the current UTC month, up to `now`: one to
 * three a day, each costing a whole number of cents (3 to 20), so the AI spend chart has something to show.
 * Written directly, dated by `finished_at`: the run service stamps the real clock. A month's total is
 * about 5.50 USD and never more than `MONTH_CAP_CENTS` (12.00 USD, 60% of the demo's 20.00 USD limit): a run
 * that would pass the cap is left out, so the 80% limit notice never shows on whatever date this runs.
 */
function pastRuns(now: Date, userId: string) {
  const random = randomFrom(20_261_122);
  const spent = new Map<string, number>();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const rows: { id: string; run: Prisma.AiRunUncheckedCreateInput; result: Prisma.AiRunResultUncheckedCreateInput }[] = [];
  for (let day = first; day <= today; day += DAY_MS) {
    if (random() >= 0.8) continue;
    const count = 1 + Math.floor(random() * 3);
    for (let index = 0; index < count; index++) {
      const hour = 8 + Math.floor(random() * 10);
      const startedAt = Math.min(day + hour * 3_600_000 + Math.floor(random() * 3_000_000), now.getTime() - 120_000);
      const cents = 3 + Math.floor(random() * 18);
      const month = new Date(day).toISOString().slice(0, 7);
      // Every draw above is made either way, so a skipped run doesn't change the others.
      const total = (spent.get(month) ?? 0) + cents;
      const inputTokens = 900 + Math.floor(random() * 1_500);
      const outputTokens = 150 + Math.floor(random() * 400);
      const question = QUESTIONS[Math.floor(random() * QUESTIONS.length)];
      if (total > MONTH_CAP_CENTS) continue;
      spent.set(month, total);
      const id = newId();
      rows.push({
        id,
        run: { id, userId, kind: 'ask', model: RUN_MODEL, input: { question }, createdAt: new Date(startedAt) },
        result: {
          runId: id,
          status: 'done',
          inputTokens,
          outputTokens,
          costUsd: new Prisma.Decimal(cents).div(100),
          refs: [],
          finishedAt: new Date(startedAt + 4_000),
        },
      });
    }
  }
  return rows;
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
  options: { pastRuns?: boolean; now?: Date } = {},
): Promise<AiSeedCounts> {
  const now = options.now ?? new Date();
  const { prisma } = deps;
  const auth: TenantAuth = {
    scope: 'tenant',
    tenantId,
    userId: actorUserId,
    jti: 'seed',
    expiresAt: new Date(Date.now() + DAY_MS),
    permissions: new Set(TENANT_PERMISSIONS),
  };
  const created: AiSeedCounts = { limit: 0, articles: 0, plans: 0, profiles: 0, runs: 0 };

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

  // Past runs only when asked for (the demo seed), once: none when any run is older than a day (the seed's
  // own, or real ones). Every other caller, such as a spec that counts a workspace's runs, gets none.
  if (options.pastRuns) {
    await prisma.inTenant(tenantId, async (tx) => {
      if ((await tx.aiRun.count({ where: { createdAt: { lt: new Date(now.getTime() - DAY_MS) } } })) > 0) return;
      const rows = pastRuns(now, actorUserId);
      await tx.aiRun.createMany({ data: rows.map((row) => row.run) });
      await tx.aiRunResult.createMany({ data: rows.map((row) => row.result) });
      created.runs = rows.length;
    });
  }
  return created;
}
