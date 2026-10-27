import { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/** Why a line is refused a partner other than the one holding the rest of its order. */
export const ONE_PARTNER = 'Every line of this order goes to one partner';

/**
 * Locks the order of the job's line, when the job is one, before its group is locked (Global
 * Constraints, lock order): two lines of one order handed to partners at once are judged one at a
 * time. Plain functions over `tx`, so Partners uses them without depending on Orders.
 */
export async function lockOrderOfGroup(tx: Tx, groupId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT o.id FROM "order" o JOIN order_line l ON l.tenant_id = o.tenant_id AND l.order_id = o.id
    WHERE l.group_id = ${groupId}::uuid
    FOR UPDATE OF o`;
}

/**
 * The partners holding the other lines of the job's order: offered while the offer is open, or
 * accepted. Lines made in-house and cancelled lines hold nobody; a job that isn't an order line has
 * no other lines.
 */
export async function otherLinePartners(tx: Tx, groupId: string): Promise<string[]> {
  const line = await tx.orderLine.findFirst({ where: { groupId }, select: { orderId: true } });
  if (!line) return [];
  const others = await tx.orderLine.findMany({
    where: { orderId: line.orderId, groupId: { not: groupId }, cancelledAt: null },
    select: { groupId: true },
  });
  const groupIds = others.flatMap((other) => (other.groupId ? [other.groupId] : []));
  if (groupIds.length === 0) return [];
  const held = await tx.jobAssignment.findMany({
    where: {
      groupId: { in: groupIds },
      OR: [{ status: 'accepted' }, { status: 'offered', expiresAt: { gt: new Date() } }],
    },
    select: { partnerId: true },
  });
  return [...new Set(held.map((row) => row.partnerId))];
}
