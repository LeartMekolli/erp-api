import type { Prisma } from '../../generated/prisma/client';

// An order waits for payment while its production has not started (Payments spec, B1): its groups
// and its workshop's job exist, so the capacity stays held, but nothing of it is made, offered or
// shown to the workshop. Started never goes back to not started, so a read without a lock is safe.

export const WAITING_FOR_PAYMENT = 'The order is waiting for payment';

/** A group of an order line, or of a part of one, whose order has not started. */
const waiting: Prisma.WorkOrderGroupWhereInput = {
  OR: [
    { orderLine: { is: { order: { productionStartedAt: null } } } },
    { orderLinePart: { is: { line: { order: { productionStartedAt: null } } } } },
  ],
};

/** Groups that are not held for payment: any group not of an order line, or of a started order. */
export const notWaitingForPayment: Prisma.WorkOrderGroupWhereInput = { NOT: waiting };

/** Which of `groupIds` belong to an order that waits for payment. */
export async function waitingGroupIds(tx: Prisma.TransactionClient, groupIds: string[]): Promise<Set<string>> {
  if (groupIds.length === 0) return new Set();
  const rows = await tx.workOrderGroup.findMany({ where: { id: { in: groupIds }, ...waiting }, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}
