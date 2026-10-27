import { Prisma } from '../../generated/prisma/client';
import type { SettingKey } from '../settings/setting-keys';
import { localDate, workingDaysBefore } from './dates';
import type { BusinessCalendar } from './dates';
import { DEFAULT_CALENDAR } from './place-order';

type Tx = Prisma.TransactionClient;

/** What a workspace that never set `orders.scheduling` works by (Orders spec, B3). */
const DEFAULT_SCHEDULING = { bufferDays: 2, assemblyAllowanceDays: 1 };

/** Today's date in the workspace's timezone. */
export async function workspaceToday(tx: Tx, tenantId: string): Promise<string> {
  const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
  return localDate(new Date(), timezone);
}

/**
 * The day a partner's job is due by default (Orders spec, B3): the order's promised date less the
 * buffer in working days, a part of an assembly one allowance more, and never before `today`. A job that
 * isn't an order line has no default. The job's source names its line, which is read whether or not the
 * line yet points back at the group, so a direct job can ask as it starts.
 */
export async function defaultDueOn(
  tx: Tx,
  groupId: string,
  settings: Partial<Record<SettingKey, unknown>>,
  today: string,
): Promise<string | null> {
  const group = await tx.workOrderGroup.findUnique({ where: { id: groupId }, select: { sourceType: true, sourceId: true } });
  if (group?.sourceType !== 'order_line') return null;
  const line = await tx.orderLine.findUnique({ where: { id: group.sourceId }, select: { order: { select: { promisedOn: true } } } });
  const part = line ? null : await tx.orderLinePart.findUnique({ where: { id: group.sourceId }, select: { line: { select: { order: { select: { promisedOn: true } } } } } });
  const promisedOn = line?.order.promisedOn ?? part?.line.order.promisedOn;
  if (!promisedOn) return null;

  const scheduling = (settings['orders.scheduling'] as typeof DEFAULT_SCHEDULING | undefined) ?? DEFAULT_SCHEDULING;
  const calendar = (settings['business.calendar'] as BusinessCalendar | undefined) ?? DEFAULT_CALENDAR;
  const days = scheduling.bufferDays + (part ? scheduling.assemblyAllowanceDays : 0);
  const due = workingDaysBefore(promisedOn.toISOString().slice(0, 10), days, calendar);
  return due < today ? today : due;
}

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
