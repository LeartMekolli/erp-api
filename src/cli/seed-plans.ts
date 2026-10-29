import type { PrismaService } from '../database/prisma.service';
import type { TenantAuth } from '../modules/identity/auth-context';
import { TENANT_PERMISSIONS } from '../modules/identity/permissions';
import type { CampaignsService } from '../modules/payments/credits/campaigns.service';
import type { CreditPacksService } from '../modules/payments/credits/credit-packs.service';
import type { CreatePlan } from '../modules/payments/plans/plan-response';
import type { PlansService } from '../modules/payments/plans/plans.service';

// Demo plans and credits for the demo workspace, on top of its delivery speeds (`seed-pricing.ts`) and
// customers (`seed-customers.ts`, `seed-payments.ts`): Starter with trial credits and limits, Pro and
// Business, two credit packs and a campaign welcoming new Pro customers.

const DAY_MS = 86_400_000;

/** What Starter gets, unless staff have changed it already. */
const STARTER = { monthly_credits: 10, member_limit: 2, features: [] };

const PLANS: CreatePlan[] = [
  {
    key: 'pro',
    name: 'Pro',
    description: 'A lower price, express delivery and monthly credits.',
    position: 1,
    monthly_price: '29.00',
    yearly_price: '290.00',
    discount_percent: '5',
    monthly_credits: 100,
    member_limit: 5,
    features: ['progress_emails'],
    speeds: [{ key: 'express', surcharge_percent: null }],
  },
  {
    key: 'business',
    name: 'Business',
    description: 'The lowest price, every speed, pay later and the most credits.',
    position: 2,
    monthly_price: '99.00',
    yearly_price: '990.00',
    discount_percent: '10',
    monthly_credits: 400,
    member_limit: null,
    features: ['progress_emails', 'pay_later'],
    // Rush at the demo speed's 30 % less 10 points.
    speeds: [
      { key: 'express', surcharge_percent: null },
      { key: 'rush', surcharge_percent: '20' },
    ],
  },
];

const PACKS = [
  { name: '100 credits', credits: 100, price: '10.00', valid_days: 365, position: 0 },
  { name: '500 credits', credits: 500, price: '40.00', valid_days: 365, position: 1 },
];

const CAMPAIGN = { name: 'Welcome to Pro', credits_per_customer: 50, credit_days: 60, budget: 5000, plan: 'pro', runsForDays: 365 };

export interface PlansSeedCounts {
  /** 1 when Starter was given its demo limits and credits. */
  starter: number;
  plans: number;
  packs: number;
  campaigns: number;
}

/**
 * Seeds the demo plans, packs and campaign into one workspace, through the services, so each is
 * audited as `actorUserId` and each plan is published when the workspace has payment keys. Idempotent:
 * a plan is found by key, a pack and the campaign by name, and anything found is left as it is.
 * Starter is changed only while it still has the values a new workspace gives it. Demo customers
 * already paying later keep their terms: a plan never changes them.
 */
export async function seedPlans(
  deps: { prisma: PrismaService; plans: PlansService; packs: CreditPacksService; campaigns: CampaignsService },
  tenantId: string,
  actorUserId: string,
): Promise<PlansSeedCounts> {
  const { prisma } = deps;
  const auth: TenantAuth = {
    scope: 'tenant',
    tenantId,
    userId: actorUserId,
    jti: 'seed',
    expiresAt: new Date(Date.now() + DAY_MS),
    permissions: new Set(TENANT_PERMISSIONS),
  };
  const created: PlansSeedCounts = { starter: 0, plans: 0, packs: 0, campaigns: 0 };

  const existing = await prisma.inTenant(tenantId, async (tx) => ({
    plans: await tx.plan.findMany({
      select: { id: true, key: true, isDefault: true, monthlyCredits: true, memberLimit: true, features: true, discountPercent: true },
    }),
    packs: await tx.creditPack.findMany({ select: { name: true } }),
    campaigns: await tx.creditCampaign.findMany({ select: { name: true } }),
  }));

  const starter = existing.plans.find((plan) => plan.isDefault)!;
  const untouched =
    starter.monthlyCredits === 0 &&
    starter.memberLimit === null &&
    starter.discountPercent.isZero() &&
    starter.features.length === 1 &&
    starter.features[0] === 'pay_later';
  if (untouched) {
    await deps.plans.update(auth, starter.id, STARTER);
    created.starter++;
  }

  const planIds = new Map(existing.plans.map((plan) => [plan.key, plan.id]));
  for (const plan of PLANS) {
    if (planIds.has(plan.key)) continue;
    planIds.set(plan.key, (await deps.plans.create(auth, plan)).id);
    created.plans++;
  }
  // Prices left unpublished by an earlier run without keys go out once the keys are there.
  await deps.plans.publish(tenantId);

  const packNames = new Set(existing.packs.map((pack) => pack.name));
  for (const pack of PACKS) {
    if (packNames.has(pack.name)) continue;
    await deps.packs.create(auth, pack);
    created.packs++;
  }

  if (!existing.campaigns.some((campaign) => campaign.name === CAMPAIGN.name)) {
    const now = Date.now();
    const campaign = await deps.campaigns.create(auth, {
      name: CAMPAIGN.name,
      credits_per_customer: CAMPAIGN.credits_per_customer,
      credit_days: CAMPAIGN.credit_days,
      starts_at: new Date(now).toISOString(),
      ends_at: new Date(now + CAMPAIGN.runsForDays * DAY_MS).toISOString(),
      budget: CAMPAIGN.budget,
      targets: { plan_ids: [planIds.get(CAMPAIGN.plan)!], customer_ids: [] },
    });
    await deps.campaigns.activate(auth, campaign.id);
    created.campaigns++;
  }
  return created;
}
