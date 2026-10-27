import { z } from 'zod';
import { REFUSAL_CODES } from '../catalog/check-response';
import { currentPriceSchema } from '../catalog/material-response';
import { MEASURE_TYPES } from '../files/measurers';
import { SUMMARY_GROUPS } from './pricing-response';

// What clients receive for quotes; checked against real responses in the e2e tests. Decimals are
// strings: prices to cents, intermediate amounts to at most 10 places.

/** The Catalog check's refusals, and the ones pricing adds. */
export const QUOTE_REFUSAL_CODES = [
  ...REFUSAL_CODES,
  'no_steps',
  'price_too_large',
  'step_conflict',
  'step_price_missing',
  'density_missing',
  'unit_mismatch',
  // The product has no workflow, or its workflow lacks a step the quote prices (Workflow/QC spec F13).
  'workflow_missing',
  'workflow_step_missing',
  // The workshop the customer picked can't take the job right now (Partners spec, goal 12).
  'partner_unavailable',
  // An assembly's quantity needs more of a part than one quote can hold (Orders spec, goal 6).
  'quantity_too_large',
] as const;
export type QuoteRefusalCode = (typeof QUOTE_REFUSAL_CODES)[number];

export const quoteRefusalSchema = z.strictObject({
  code: z.enum(QUOTE_REFUSAL_CODES),
  message: z.string(),
  /** The option rule that refused, for `rule_excludes` and `rule_requires`. */
  rule_id: z.uuid().optional(),
  /** The step that could not be priced, or that the product's workflow lacks, by key. */
  step: z.string().optional(),
  /** For an assembly: the position of the part that refused. */
  part: z.number().int().optional(),
});
export type QuoteRefusal = z.infer<typeof quoteRefusalSchema>;

export const SUMMARY_LABELS = [...SUMMARY_GROUPS, 'quantity_discount', 'your_discount', 'delivery_speed'] as const;

/** The customer's view: grouped lines that add up to the price, and nothing internal. */
export const quoteSummaryResponseSchema = z.strictObject({
  id: z.uuid(),
  product: z.strictObject({ id: z.uuid(), name: z.string() }),
  quantity: z.number().int(),
  currency: z.string(),
  /** They sum exactly to `unit_price`. */
  lines: z.array(z.strictObject({ label: z.enum(SUMMARY_LABELS), amount: z.string() })),
  unit_price: z.string(),
  /** `unit_price` × `quantity`. */
  total: z.string(),
  /** Until then, ordering with this quote uses its price. */
  expires_at: z.string(),
  expired: z.boolean(),
});
export type QuoteSummaryResponse = z.infer<typeof quoteSummaryResponseSchema>;

/** A price as the customer would be quoted it, not saved: the summary's lines and totals. */
export const quotePriceSchema = quoteSummaryResponseSchema.pick({ currency: true, lines: true, unit_price: true, total: true });
export type QuotePrice = z.infer<typeof quotePriceSchema>;

/** A saved quote (201), or why the configuration cannot be quoted (200, nothing saved). */
export const quoteResultResponseSchema = z.discriminatedUnion('accepted', [
  z.strictObject({ accepted: z.literal(true), quote: quoteSummaryResponseSchema }),
  z.strictObject({ accepted: z.literal(false), reasons: z.array(quoteRefusalSchema) }),
]);
export type QuoteResultResponse = z.infer<typeof quoteResultResponseSchema>;

const amount = z.string();

export const breakdownSchema = z.strictObject({
  scale: z.string(),
  /** The design's measures at `scale`, in catalog units. */
  measures: z.array(z.strictObject({ type: z.enum(MEASURE_TYPES), value: z.string(), unit: z.string() })),
  /** Costs per piece, in chain order. */
  steps: z.array(
    z.strictObject({
      key: z.string(),
      name: z.string(),
      summary_group: z.enum(SUMMARY_GROUPS),
      blocks: z.array(
        z.strictObject({
          kind: z.string(),
          /** Grams, ml, minutes, cm², batches...: what `rate` is charged on. */
          quantity: z.string().optional(),
          unit: z.string().optional(),
          rate: z.string().optional(),
          amount,
        }),
      ),
      subtotal: amount,
      /** The failure allowance on the subtotal. */
      failure: amount,
      cost: amount,
    }),
  ),
  cost_per_piece: amount,
  overhead: amount,
  min_size_surcharge: amount,
  margin: z.strictObject({ percent: z.string(), amount }),
  price_before_adjustments: amount,
  /** In the order applied, each on the result of the one before; discounts are negative. */
  adjustments: z.array(
    z.strictObject({ kind: z.enum(['quantity_discount', 'customer_group', 'delivery_speed']), percent: z.string(), amount }),
  ),
  unit_price_exact: amount,
  unit_price: amount,
  total: amount,
  /**
   * An assembly's parts, each its own quote at the quantity the line needs; the figures above are
   * the assembly's own steps, and the quote's price is theirs plus every part's. Empty otherwise.
   */
  parts: z.array(
    z.strictObject({
      position: z.number().int(),
      product: z.strictObject({ id: z.uuid(), name: z.string() }),
      quantity: z.number().int(),
      quote_id: z.uuid(),
      unit_price: amount,
      total: amount,
    }),
  ),
});
export type BreakdownJson = z.infer<typeof breakdownSchema>;

export const quoteInputsSchema = z.strictObject({
  /** Every answered group's value key by group key, defaults included. */
  options: z.record(z.string(), z.string()),
  size: z.union([z.strictObject({ scale: z.string() }), z.strictObject({ named: z.string() })]).nullable(),
  file_version_id: z.uuid().nullable(),
  customer_group: z.string().nullable(),
  /** The speed named, else the workspace's default, else none. */
  delivery_speed: z.string().nullable(),
});
export type QuoteInputs = z.infer<typeof quoteInputsSchema>;

export const quoteMaterialSchema = currentPriceSchema.omit({ currency: true }).extend({ id: z.uuid(), key: z.string() });
export type QuoteMaterial = z.infer<typeof quoteMaterialSchema>;

/** The staff view: every number, and where each input came from. */
export const quoteResponseSchema = z.strictObject({
  id: z.uuid(),
  product_id: z.uuid(),
  quantity: z.number().int(),
  currency: z.string(),
  unit_price: z.string(),
  total: z.string(),
  expires_at: z.string(),
  expired: z.boolean(),
  created_at: z.string(),
  /** The customer the quote is for; null for an internal quote. */
  customer_id: z.uuid().nullable(),
  /** The workshop the customer picked, and what it is paid for the job; null at the workspace's own prices. */
  partner: z.strictObject({ id: z.uuid(), cost: z.string() }).nullable(),
  inputs: quoteInputsSchema,
  /** The configuration's material and every material a step names, as priced at quote time. */
  materials: z.array(quoteMaterialSchema),
  breakdown: breakdownSchema,
});
export type QuoteResponse = z.infer<typeof quoteResponseSchema>;
