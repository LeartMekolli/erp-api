import { z } from 'zod';
import { BUCKETS } from '../reporting/range-buckets';

// `GET /partner-portal/partners/:id/summary` (dashboard data spec, "Partner summary").

const money = z.string().regex(/^-?\d+\.\d{2}$/);

export const partnerSummaryResponseSchema = z.strictObject({
  range: z.strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    // The same number of days, ending the day before `from`.
    previous_from: z.iso.date(),
    previous_to: z.iso.date(),
    bucket: z.enum(BUCKETS),
  }),
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
  currency: z.string().length(3).optional(),
  // Every bucket of the range, oldest first, an empty one with "0.00".
  series: z
    .array(z.strictObject({ start: z.iso.date(), days: z.number().int().min(1), paid: money, owed: money }))
    .optional(),
});
export type PartnerSummaryResponse = z.infer<typeof partnerSummaryResponseSchema>;
