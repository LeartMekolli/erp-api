import { z } from 'zod';

// What clients receive for claims (Orders 3 spec, goals 1–7); checked against real responses in the e2e tests.

/** Derived from the return and the lines, never stored. */
export const CLAIM_STATES = ['open', 'awaiting_return', 'decided', 'closed'] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];
export const CLAIM_FAULTS = ['workshop', 'workspace', 'courier', 'customer'] as const;
export const CLAIM_OUTCOMES = ['remake', 'refund', 'refuse'] as const;

const decisionSchema = z.strictObject({
  fault: z.enum(CLAIM_FAULTS),
  outcome: z.enum(CLAIM_OUTCOMES),
  /** Staff's own; never shown to the customer. */
  note: z.string().nullable(),
  /** Shown to the customer; always given for a refusal. */
  customer_reason: z.string().nullable(),
  refund_amount: z.string().nullable(),
  remake_group_id: z.uuid().nullable(),
});

const claimLineSchema = z.strictObject({
  id: z.uuid(),
  order_line: z.strictObject({ id: z.uuid(), position: z.number().int(), product_name: z.string() }),
  pieces: z.number().int(),
  /** Null until staff decide the line. */
  decision: decisionSchema.nullable(),
});

export const claimResponseSchema = z.strictObject({
  id: z.uuid(),
  /** Readable, counted per workspace from 1. */
  number: z.number().int(),
  order: z.strictObject({ id: z.uuid(), number: z.number().int() }),
  state: z.enum(CLAIM_STATES),
  reason: z.strictObject({ key: z.string(), name: z.string() }),
  description: z.string(),
  photos: z.array(z.strictObject({ file_version_id: z.uuid() })),
  /** Set once staff ask for the pieces back. */
  return: z.strictObject({ requested_at: z.iso.datetime(), returned_at: z.iso.datetime().nullable() }).nullable(),
  lines: z.array(claimLineSchema),
  /** The parcel carrying the claim's remakes, once shipped. */
  shipment: z
    .strictObject({
      courier: z.string().nullable(),
      tracking: z.string().nullable(),
      shipped_at: z.iso.datetime(),
      delivered_at: z.iso.datetime().nullable(),
    })
    .nullable(),
  created_at: z.iso.datetime(),
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

/** A line decided: the claim, and for a remake its group and why the workshop at fault wasn't offered it. */
export const claimDecisionResponseSchema = claimResponseSchema.extend({
  remake: z.strictObject({ group_id: z.uuid(), unassigned_reasons: z.array(z.string()) }).nullable(),
});
export type ClaimDecisionResponse = z.infer<typeof claimDecisionResponseSchema>;

/** A claim as its customer sees it: never whose fault staff found, nor their note. */
export const customerClaimResponseSchema = claimResponseSchema.extend({
  lines: z.array(claimLineSchema.extend({ decision: decisionSchema.omit({ fault: true, note: true }).nullable() })),
});
export type CustomerClaimResponse = z.infer<typeof customerClaimResponseSchema>;
