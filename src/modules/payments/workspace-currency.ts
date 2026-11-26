import type { Prisma } from '../../generated/prisma/client';

/**
 * The currency the workspace bills in: one per workspace, with no conversion. What a customer owes and
 * its credit limit are in it. Read in the caller's tenant transaction, where row-level security leaves
 * only the workspace's own tenant row.
 */
export async function workspaceCurrency(tx: Prisma.TransactionClient): Promise<string> {
  return (await tx.tenant.findFirstOrThrow({ select: { defaultCurrency: true } })).defaultCurrency;
}
