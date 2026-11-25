import { z } from 'zod';
import { likeLiteral } from '../../database/like';
import type { Prisma } from '../../generated/prisma/client';
import type { TenantAuth } from '../identity/auth-context';
import { barredStepIds } from './step-skills';

/**
 * How a work list may be sorted (Production lists spec, goal 2). `priority`: first-in-line customers' groups
 * first, then as the pieces started; `due_on`/`-due_on`: by the group's promise, undated pieces last either way,
 * then as `priority`; `started`: as the pieces started.
 */
export const PIECE_SORTS = ['priority', 'due_on', '-due_on', 'started'] as const;
export type PieceSort = (typeof PIECE_SORTS)[number];

/** The filters every list of pieces shares, so a list, its counts and its groups always agree. */
export const pieceFilterSchema = z.object({
  /** Every version of the workflow. */
  workflow_id: z.uuid().optional(),
  /**
   * Part of the product's name or the customer's, or an order's or claim's number (`#` optional), any case,
   * `%` and `_` taken literally. Numbers need `order.read`, the customer's name `customer.read`.
   */
  q: z.string().trim().min(1).max(100).optional(),
  /** Only the pieces the caller may pass or fail where they are (`may_work`). */
  workable: z.literal('true').optional(),
});
export type PieceFilters = z.infer<typeof pieceFilterSchema>;

const ORDER_NUMBER = /^#?(\d{1,9})$/;

/** The groups `q` finds, with only what the caller may read: never by a number or a name it couldn't see. */
export function searchGroups(q: string, auth: TenantAuth): Prisma.WorkOrderGroupWhereInput {
  const contains = { contains: likeLiteral(q), mode: 'insensitive' as const };
  const digits = ORDER_NUMBER.exec(q)?.[1];
  const number = digits === undefined ? null : Number(digits);
  return {
    OR: [
      { product: { is: { name: contains } } },
      ...(number !== null && auth.permissions.has('order.read')
        ? [
            { orderLine: { is: { order: { number } } } },
            { orderLinePart: { is: { line: { order: { number } } } } },
            { remakeOf: { is: { claim: { OR: [{ number }, { order: { number } }] } } } },
          ]
        : []),
      ...(auth.permissions.has('customer.read') ? [{ customer: { is: { name: contains } } }] : []),
    ],
  };
}

/**
 * The pieces `filters` pick. `workable` keeps the active pieces at a step the caller may work, which takes
 * `workflow.move` and, at a step that requires a skill, that skill; `barred` are those steps when already read.
 */
export async function pieceWhere(
  tx: Prisma.TransactionClient,
  filters: PieceFilters,
  auth: TenantAuth,
  barred?: Set<string>,
): Promise<Prisma.WorkOrderWhereInput> {
  const and: Prisma.WorkOrderWhereInput[] = [];
  if (filters.workflow_id) and.push({ group: { workflowVersion: { workflowId: filters.workflow_id } } });
  if (filters.q) and.push({ group: searchGroups(filters.q, auth) });
  if (filters.workable === 'true') {
    if (!auth.permissions.has('workflow.move')) return { id: { in: [] } };
    and.push({ status: 'active', currentStepId: { notIn: [...(barred ?? (await barredStepIds(tx, auth)))] } });
  }
  return { AND: and };
}
