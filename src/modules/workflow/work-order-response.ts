import { z } from 'zod';

// What clients receive for work orders; checked against real responses in the e2e tests.

export const WORK_ORDER_STATUSES = ['active', 'finished', 'scrapped', 'cancelled'] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

const stepRefSchema = z.strictObject({ id: z.uuid(), key: z.string(), name: z.string() });

export const workOrderResponseSchema = z.strictObject({
  id: z.uuid(),
  group_id: z.uuid(),
  number: z.number().int(),
  /** The piece's number out of the group's quantity, such as "3/10". */
  label: z.string(),
  status: z.enum(WORK_ORDER_STATUSES),
  /** Where the piece is now; null once it is finished, scrapped or cancelled. */
  step: stepRefSchema.nullable(),
  /** The scrapped piece this one replaces. */
  replaces_id: z.uuid().nullable(),
  created_at: z.iso.datetime(),
});
export type WorkOrderResponse = z.infer<typeof workOrderResponseSchema>;

export const workOrderDetailResponseSchema = workOrderResponseSchema.extend({
  /** Every step the piece goes through, in order. */
  path: z.array(z.strictObject({ key: z.string(), name: z.string() })),
  /** The instructions for the piece's current step. */
  sop_file_version_id: z.uuid().nullable(),
});
export type WorkOrderDetailResponse = z.infer<typeof workOrderDetailResponseSchema>;

export const groupResponseSchema = z.strictObject({
  id: z.uuid(),
  workflow: z.strictObject({ id: z.uuid(), name: z.string(), version: z.number().int() }),
  source: z.strictObject({ type: z.enum(['quote', 'order_line']), id: z.uuid() }),
  product_id: z.uuid().nullable(),
  customer_id: z.uuid().nullable(),
  /** How many good pieces the group delivers. */
  quantity: z.number().int(),
  pieces: z.strictObject({ active: z.number().int(), finished: z.number().int(), scrapped: z.number().int() }),
  /** The path, with how many active pieces are at each step. */
  steps: z.array(z.strictObject({ key: z.string(), name: z.string(), count: z.number().int() })),
});
export type GroupResponse = z.infer<typeof groupResponseSchema>;
