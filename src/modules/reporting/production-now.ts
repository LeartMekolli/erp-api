import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/** The active pieces now at one step type: split by who does the step, and how many are late. */
export const wipRowSchema = z.strictObject({
  step_type_id: z.uuid(),
  name: z.string(),
  in_house: z.number().int().min(0),
  at_partner: z.number().int().min(0),
  late: z.number().int().min(0),
});
export type WipRow = z.infer<typeof wipRowSchema>;

/**
 * Active pieces (not finished, scrapped or cancelled) by the type of the step they are at, in the order of
 * the steps. A step the workspace does itself counts as in house, any other as at a partner (a job only
 * offered included). A piece at a partner step is late once its group's accepted job is past its `due_on`;
 * at an in-house step, or without an accepted job (or one with no date), once its order's `promised_on` has
 * passed. Pieces of an order still waiting for payment (production not started) are left out, as the workshop
 * does not see them. `today` is the workspace's local date.
 */
export async function productionNow(tx: Tx, today: string): Promise<WipRow[]> {
  return tx.$queryRaw<WipRow[]>`
    SELECT st.id AS step_type_id,
           st.name AS name,
           count(*) FILTER (WHERE ws.done_by = 'workspace')::int AS in_house,
           count(*) FILTER (WHERE ws.done_by <> 'workspace')::int AS at_partner,
           count(*) FILTER (WHERE (CASE WHEN ws.done_by = 'workspace' THEN o.promised_on ELSE coalesce(job.due_on, o.promised_on) END) < ${today}::date)::int AS late
    FROM work_order wo
    JOIN workflow_step ws ON ws.id = wo.current_step_id
    JOIN step_type st ON st.id = ws.step_type_id
    LEFT JOIN order_line ol ON ol.group_id = wo.group_id
    LEFT JOIN order_line_part olp ON olp.group_id = wo.group_id
    LEFT JOIN order_line pl ON pl.id = olp.line_id
    LEFT JOIN "order" o ON o.id = coalesce(ol.order_id, pl.order_id)
    LEFT JOIN LATERAL (
      SELECT ja.due_on
      FROM job_assignment ja
      WHERE ja.group_id = wo.group_id AND ja.status = 'accepted'
      ORDER BY ja.created_at DESC
      LIMIT 1
    ) job ON true
    WHERE wo.status = 'active'
      AND (o.id IS NULL OR o.production_started_at IS NOT NULL)
    GROUP BY st.id, st.name
    ORDER BY min(ws.position), st.name`;
}
