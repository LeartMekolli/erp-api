import { z } from 'zod';
import { rangeBlockSchema } from '../reporting/range-buckets';
import { money } from '../reporting/week-metrics';

// `GET /partner-portal/partners/:id/summary` (dashboard data spec, "Partner summary").

export const partnerSummaryResponseSchema = z.strictObject({
  range: rangeBlockSchema,
  // Jobs the partner finished its part of in the range, and in the range before it.
  jobs_finished: z.number().int().min(0),
  previous_jobs_finished: z.number().int().min(0),
  // The partner's active pieces now, per step it does, in the order of the steps.
  steps: z.array(
    z.strictObject({
      key: z.string(),
      name: z.string(),
      on_track: z.number().int().min(0),
      late: z.number().int().min(0),
    }),
  ),
  // Money is left out, never zeroed, for a member.
  earned: money.optional(),
  previous_earned: money.optional(),
  // In the current range: what paid payouts hold, what pending payouts hold, and the rest; they add up to `earned`.
  paid_total: money.optional(),
  pending_total: money.optional(),
  owed_total: money.optional(),
  currency: z.string().length(3).optional(),
  // Every bucket of the range, oldest first, an empty one with "0.00".
  series: z
    .array(z.strictObject({ start: z.iso.date(), days: z.number().int().min(1), paid: money, pending: money, owed: money }))
    .optional(),
});
export type PartnerSummaryResponse = z.infer<typeof partnerSummaryResponseSchema>;
