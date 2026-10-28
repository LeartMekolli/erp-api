import type { Prisma } from '../../../generated/prisma/client';
import type { PlanFeature } from './plans';

/**
 * A plan's benefits, read live (Payments 2 spec, goal 8). Plain functions on a transaction, so Pricing
 * and Customers can ask without depending on PaymentsModule.
 */
export interface PlanBenefits {
  id: string;
  key: string;
  name: string;
  isDefault: boolean;
  discountPercent: Prisma.Decimal;
  /** By delivery speed key, beyond the workspace's default speed; null = the speed's own surcharge. */
  speeds: ReadonlyMap<string, Prisma.Decimal | null>;
  monthlyCredits: number;
  memberLimit: number | null;
  features: ReadonlySet<PlanFeature>;
}

const include = { speeds: { include: { deliverySpeed: { select: { key: true } } } } } as const;

type PlanRow = Prisma.PlanGetPayload<{ include: typeof include }>;

function toBenefits(row: PlanRow): PlanBenefits {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    isDefault: row.isDefault,
    discountPercent: row.discountPercent,
    speeds: new Map(row.speeds.map((speed) => [speed.deliverySpeed.key, speed.surchargePercent])),
    monthlyCredits: row.monthlyCredits,
    memberLimit: row.memberLimit,
    features: new Set(row.features as PlanFeature[]),
  };
}

/** The workspace's free default plan; every workspace has one (`createDefaultPlan`). */
export async function defaultPlanOf(tx: Prisma.TransactionClient): Promise<PlanBenefits> {
  return toBenefits(await tx.plan.findFirstOrThrow({ where: { isDefault: true }, include }));
}

export async function planBenefits(tx: Prisma.TransactionClient, planId: string): Promise<PlanBenefits> {
  return toBenefits(await tx.plan.findUniqueOrThrow({ where: { id: planId }, include }));
}

/** Subscriptions that give their plan: paid, or late but not given up on by the provider. */
export const PLAN_GIVING_STATUSES = ['active', 'past_due'] as const;

/** The customer's plan: its subscription's while active or past due, else the default plan. */
export async function planOf(tx: Prisma.TransactionClient, customerId: string): Promise<PlanBenefits> {
  const subscription = await tx.customerSubscription.findFirst({
    where: { customerId, status: { in: [...PLAN_GIVING_STATUSES] } },
    select: { planPrice: { select: { planId: true } } },
  });
  return subscription ? planBenefits(tx, subscription.planPrice.planId) : defaultPlanOf(tx);
}
