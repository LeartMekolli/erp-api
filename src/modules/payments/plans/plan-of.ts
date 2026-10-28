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

/** The customer's plan: its subscription's while active or past due (Task 4), else the default plan. */
export function planOf(tx: Prisma.TransactionClient, _customerId: string): Promise<PlanBenefits> {
  return defaultPlanOf(tx);
}
