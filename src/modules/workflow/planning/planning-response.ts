import { z } from 'zod';

export const setCapacitySchema = z.strictObject({
  /** Pieces a day the step type can take in-house; null removes the limit. */
  daily_pieces: z.number().int().min(1).max(100_000).nullable(),
});
export type SetCapacity = z.infer<typeof setCapacitySchema>;

export const planQuerySchema = z.strictObject({
  step_type_id: z.uuid(),
  /** The day to plan; the workspace's today when left out. */
  date: z.iso.date().optional(),
});
export type PlanQuery = z.infer<typeof planQuerySchema>;

const stepTypeRefSchema = z.strictObject({ id: z.uuid(), key: z.string(), name: z.string() });

export const stepCapacityResponseSchema = z.strictObject({ step_type: stepTypeRefSchema, daily_pieces: z.number().int().nullable() });
export type StepCapacityResponse = z.infer<typeof stepCapacityResponseSchema>;
export const stepCapacitiesResponseSchema = z.strictObject({ data: z.array(stepCapacityResponseSchema) });
export type StepCapacitiesResponse = z.infer<typeof stepCapacitiesResponseSchema>;

/** One group's pieces at the step type on one planned day. */
const planItemSchema = z.strictObject({
  group_id: z.uuid(),
  order: z.strictObject({ id: z.uuid(), number: z.number().int() }).nullable(),
  product_name: z.string().nullable(),
  customer: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  /** The customer's band in force; the default band without a customer. */
  band: z.strictObject({ key: z.string(), name: z.string() }),
  pieces: z.number().int(),
  planned_on: z.iso.date(),
  promised_on: z.iso.date(),
});

/**
 * A step type's plan for a day (Orders 3 spec, goals 18–19), each list in priority order: the band in
 * force first, then the earliest promise, then start order. A guide: staff may work further down.
 */
export const stepPlanResponseSchema = z.strictObject({
  date: z.iso.date(),
  step_type: stepTypeRefSchema,
  daily_pieces: z.number().int().nullable(),
  /** Planned for the day, within its capacity. */
  planned: z.array(planItemSchema),
  /** On today only: work whose day has passed, or that no day before had room for. */
  late: z.array(planItemSchema),
  /** Planned for the next five open days. */
  next: z.array(planItemSchema),
  /** Open days among the next 14 planned past the capacity. */
  over_capacity: z.array(
    z.strictObject({ date: z.iso.date(), pieces: z.number().int(), daily_pieces: z.number().int(), suggestion: z.string() }),
  ),
});
export type StepPlanResponse = z.infer<typeof stepPlanResponseSchema>;
