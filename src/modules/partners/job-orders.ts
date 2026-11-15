import type { Prisma } from '../../generated/prisma/client';
import type { JobOrderResponse } from './partner-response';

type Tx = Prisma.TransactionClient;

/** The order a job is from, and whether the job is a claim's remake rather than the line's own work. */
export interface JobOrder {
  order: JobOrderResponse;
  remake: boolean;
}

const orderOfLine = { position: true, order: { select: { id: true, number: true } } } as const;

/**
 * Per job, by group id: its order line's order, its line part's line's, or for a claim remake the
 * claimed line's. A job from a quote has none. Three reads for any number of jobs.
 */
export async function jobOrders(tx: Tx, groupIds: string[]): Promise<Map<string, JobOrder>> {
  if (groupIds.length === 0) return new Map();
  const lines = await tx.orderLine.findMany({ where: { groupId: { in: groupIds } }, select: { groupId: true, ...orderOfLine } });
  const parts = await tx.orderLinePart.findMany({ where: { groupId: { in: groupIds } }, select: { groupId: true, line: { select: orderOfLine } } });
  const remakes = await tx.claimLine.findMany({
    where: { remakeGroupId: { in: groupIds } },
    select: { remakeGroupId: true, orderLine: { select: orderOfLine } },
  });
  const entry = (line: { position: number; order: { id: string; number: number } }, remake: boolean): JobOrder => ({
    order: { id: line.order.id, number: line.order.number, line_position: line.position },
    remake,
  });
  return new Map([
    ...lines.flatMap((line) => (line.groupId ? [[line.groupId, entry(line, false)] as const] : [])),
    ...parts.flatMap((part) => (part.groupId ? [[part.groupId, entry(part.line, false)] as const] : [])),
    ...remakes.flatMap((claimed) => (claimed.remakeGroupId ? [[claimed.remakeGroupId, entry(claimed.orderLine, true)] as const] : [])),
  ]);
}
