import type { Prisma } from '../../../generated/prisma/client';

/**
 * The free plan every customer is on until it subscribes (Payments 2 spec, goal 2): no price, no
 * discount, no credits, two members, and only the workspace's default delivery speed. Run in the new
 * workspace's transaction; staff may edit it later, but never archive it.
 */
export async function createDefaultPlan(tx: Prisma.TransactionClient): Promise<void> {
  const { defaultCurrency } = await tx.tenant.findFirstOrThrow({ select: { defaultCurrency: true } });
  await tx.plan.create({
    data: {
      key: 'starter',
      name: 'Starter',
      description: 'Order at standard prices and speed.',
      position: 0,
      isDefault: true,
      currency: defaultCurrency,
      memberLimit: 2,
    },
  });
}
