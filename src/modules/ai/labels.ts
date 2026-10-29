import type { Prisma } from '../../generated/prisma/client';
import type { TenantPermission } from '../identity/permissions';
import type { RecordRef } from './tools/tool';

type Tx = Prisma.TransactionClient;

/** The permission a reader needs to see a record of each type, as on its screen. */
const SEEN_WITH: Record<RecordRef['type'], TenantPermission | null> = {
  order: 'order.read',
  customer: 'customer.read',
  partner: 'partner.read',
  invoice: 'payment.read',
  job: 'partner.read',
  step: 'workflow.read',
  // Published articles are read by every staff member.
  article: null,
};

export interface LabelledRef extends RecordRef {
  label: string;
}

/**
 * Each ref with its label as the record reads now, in the order given. A ref the reader may not see, or
 * whose record is gone, is left out.
 */
export async function labelled(tx: Tx, permissions: ReadonlySet<TenantPermission>, refs: RecordRef[]): Promise<LabelledRef[]> {
  const visible = refs.filter((ref) => {
    const needed = SEEN_WITH[ref.type];
    return needed === null || permissions.has(needed);
  });
  const ids = (type: RecordRef['type']) => [...new Set(visible.filter((ref) => ref.type === type).map((ref) => ref.id))];
  const labels = new Map<string, string>();
  const put = (type: RecordRef['type'], id: string, label: string) => labels.set(`${type}:${id}`, label);

  for (const row of await tx.order.findMany({ where: { id: { in: ids('order') } }, select: { id: true, number: true, customer: { select: { name: true } } } })) {
    put('order', row.id, `Order ${row.number} for ${row.customer.name}`);
  }
  for (const row of await tx.customer.findMany({ where: { id: { in: ids('customer') } }, select: { id: true, name: true } })) {
    put('customer', row.id, row.name);
  }
  for (const row of await tx.partner.findMany({ where: { id: { in: ids('partner') } }, select: { id: true, name: true } })) {
    put('partner', row.id, row.name);
  }
  for (const row of await tx.invoice.findMany({ where: { id: { in: ids('invoice') } }, select: { id: true, order: { select: { number: true } } } })) {
    put('invoice', row.id, `Invoice for order ${row.order.number}`);
  }
  for (const row of await tx.jobAssignment.findMany({ where: { id: { in: ids('job') } }, select: { id: true, partner: { select: { name: true } } } })) {
    put('job', row.id, `Job at ${row.partner.name}`);
  }
  for (const row of await tx.stepType.findMany({ where: { id: { in: ids('step') } }, select: { id: true, name: true } })) {
    put('step', row.id, row.name);
  }
  // A draft or archived article only for those who write them, as on the knowledge screens.
  const articles = await tx.knowledgeArticle.findMany({
    where: { id: { in: ids('article') }, ...(permissions.has('knowledge.write') ? {} : { status: 'published' }) },
    select: { id: true, title: true },
  });
  for (const row of articles) put('article', row.id, row.title);

  return visible.flatMap((ref) => {
    const label = labels.get(`${ref.type}:${ref.id}`);
    return label === undefined ? [] : [{ ...ref, label }];
  });
}
