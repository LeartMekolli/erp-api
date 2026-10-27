import { z } from 'zod';
import { INVOICE_STATUSES, PAYMENT_STATES, PAYMENT_TERMS } from '../payments/payment-state';
import { quoteRefusalSchema, quoteSummaryResponseSchema } from '../pricing/quote-response';
import { customerViewResponseSchema } from '../workflow/work-order-response';

// What clients receive for orders and their setup; checked against real responses in the e2e tests.

const line = z.string().trim().min(1).max(200);

/** Where an order goes, as typed with the order and copied onto it (Orders spec, goal 9). */
export const addressSchema = z.strictObject({
  name: line,
  line1: line,
  line2: line.optional(),
  city: line,
  postal_code: z.string().trim().min(1).max(20),
  region: z.string().trim().min(1).max(100).optional(),
  /** ISO 3166-1 alpha-2, upper case. */
  country: z.string().regex(/^[A-Z]{2}$/, 'an ISO 3166-1 alpha-2 country code, such as DE'),
  phone: z.string().trim().min(1).max(40).optional(),
});
export type Address = z.infer<typeof addressSchema>;

export const shippingMethodResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** Per order, in the workspace's currency. */
  price: z.string(),
  /** Only active methods can be chosen for a new order. */
  active: z.boolean(),
});
export type ShippingMethodResponse = z.infer<typeof shippingMethodResponseSchema>;

export const taxRateResponseSchema = z.strictObject({
  /** Null for the workspace's default rate. */
  country: z.string().nullable(),
  /** Null for the whole country. */
  region: z.string().nullable(),
  percent: z.string(),
});
export type TaxRateResponse = z.infer<typeof taxRateResponseSchema>;

/** The workspace's tax rates: the default first, then by country and region. */
export const taxRatesResponseSchema = z.strictObject({ data: z.array(taxRateResponseSchema) });
export type TaxRatesResponse = z.infer<typeof taxRatesResponseSchema>;

export const LINE_STATES = ['in_production', 'ready', 'cancelled'] as const;
export const ORDER_STATES = ['awaiting_payment', 'in_production', 'ready', 'shipped', 'delivered', 'cancelled'] as const;

const money = z.string().describe('In the order currency, with two decimals.');

/** An order's invoice, once it has one (pay later). */
const invoiceSchema = z.strictObject({
  url: z.string(),
  due_on: z.iso.date(),
  status: z.enum(INVOICE_STATUSES),
});

/** How the order is paid, as staff see it (Payments spec). */
export const orderPaymentResponseSchema = z.strictObject({
  /** Frozen from the customer's terms when the order was placed. */
  terms: z.enum(PAYMENT_TERMS),
  state: z.enum(PAYMENT_STATES),
  /** A pay-first order is cancelled if not paid by then. */
  pay_by: z.iso.datetime().nullable(),
  /** Waiting because the customer is past its credit limit. */
  held_for_credit: z.boolean(),
  /** Who let it start past the credit limit, and why. */
  released: z.strictObject({ by: z.strictObject({ id: z.uuid(), name: z.string() }), reason: z.string() }).nullable(),
  paid: money,
  /** Refunds that succeeded. */
  refunded: money,
  /** Where the customer pays while the order waits for payment. */
  pay_url: z.string().nullable(),
  invoice: invoiceSchema.nullable(),
});
export type OrderPaymentResponse = z.infer<typeof orderPaymentResponseSchema>;

/** How the order is paid, as its customer sees it: no terms, credit hold or release. */
export const customerOrderPaymentResponseSchema = orderPaymentResponseSchema.pick({
  state: true,
  pay_by: true,
  pay_url: true,
  invoice: true,
  paid: true,
  refunded: true,
});
export type CustomerOrderPaymentResponse = z.infer<typeof customerOrderPaymentResponseSchema>;

export const orderLineResponseSchema = z.strictObject({
  id: z.uuid(),
  /** From 0, in the order the lines were placed. */
  position: z.number().int(),
  product: z.strictObject({ id: z.uuid(), name: z.string() }),
  quantity: z.number().int(),
  unit_price: z.string(),
  total: z.string(),
  /** Derived from the line's pieces. */
  state: z.enum(LINE_STATES),
  /** The work order group the line is made as. */
  group_id: z.uuid().nullable(),
  /** The partner holding the line, offered or accepted; null while it is made in-house. */
  partner: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  /**
   * An assembly's parts, each made as its own group under the line's and priced inside the line's
   * price; empty for any other line (Orders spec, goal 6).
   */
  parts: z.array(
    z.strictObject({
      id: z.uuid(),
      /** The part's position in its assembly. */
      position: z.number().int(),
      product: z.strictObject({ id: z.uuid(), name: z.string() }),
      /** The line's quantity times how many go into one. */
      quantity: z.number().int(),
      unit_price: z.string(),
      total: z.string(),
      state: z.enum(LINE_STATES),
      group_id: z.uuid().nullable(),
      partner: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
    }),
  ),
});
export type OrderLineResponse = z.infer<typeof orderLineResponseSchema>;

/** An order as staff see it, with the totals frozen when it was placed. */
export const orderResponseSchema = z.strictObject({
  id: z.uuid(),
  /** Readable, counted per workspace from 1001. */
  number: z.number().int(),
  customer: z.strictObject({ id: z.uuid(), name: z.string() }),
  channel: z.enum(['staff', 'portal']),
  /** Derived from the lines, and shipping. */
  state: z.enum(ORDER_STATES),
  /** The day the order is promised for, in the workspace's calendar. */
  promised_on: z.iso.date(),
  /** The delivery speed key every line was priced at. */
  delivery_speed: z.string().nullable(),
  address: addressSchema,
  shipping: z.strictObject({
    method: z.strictObject({ key: z.string(), name: z.string() }),
    price: z.string(),
    courier: z.string().nullable(),
    tracking: z.string().nullable(),
    shipped_at: z.iso.datetime().nullable(),
    delivered_at: z.iso.datetime().nullable(),
  }),
  lines: z.array(orderLineResponseSchema),
  /** The lines' prices, before shipping and tax. */
  lines_total: z.string(),
  /** On the lines and the shipping together. */
  tax: z.strictObject({ percent: z.string(), amount: z.string() }),
  total: z.string(),
  currency: z.string(),
  note: z.string().nullable(),
  placed_at: z.iso.datetime(),
  payment: orderPaymentResponseSchema,
});
export type OrderResponse = z.infer<typeof orderResponseSchema>;

/** The shipping methods a customer can choose for a new order: only the active ones. */
export const portalShippingMethodsResponseSchema = z.strictObject({
  data: z.array(shippingMethodResponseSchema.pick({ key: true, name: true, price: true })),
});
export type PortalShippingMethodsResponse = z.infer<typeof portalShippingMethodsResponseSchema>;

/** A line as its customer sees it: no partner and no work order group, with the stages the customer may see. */
export const customerOrderLineResponseSchema = orderLineResponseSchema.omit({ group_id: true, partner: true }).extend({
  progress: customerViewResponseSchema,
  /** What an assembly is made of, and how far each part is; never a part's price or who makes it. */
  parts: z.array(
    z.strictObject({
      position: z.number().int(),
      product: z.strictObject({ id: z.uuid(), name: z.string() }),
      quantity: z.number().int(),
      state: z.enum(LINE_STATES),
      progress: customerViewResponseSchema,
    }),
  ),
});
export type CustomerOrderLineResponse = z.infer<typeof customerOrderLineResponseSchema>;

/** An order as its customer sees it (Global Constraints): never a partner, a partner's cost or a margin. */
export const customerOrderResponseSchema = orderResponseSchema.omit({ customer: true, channel: true }).extend({
  lines: z.array(customerOrderLineResponseSchema),
  payment: customerOrderPaymentResponseSchema,
});
export type CustomerOrderResponse = z.infer<typeof customerOrderResponseSchema>;

/**
 * 409 when a lapsed price changed or can't be worked out: nothing was placed (Orders spec, goal 2).
 * A problem response whose `code` and `lines` are its extension members.
 */
export const priceChangedResponseSchema = z.strictObject({
  type: z.string(),
  title: z.string(),
  status: z.literal(409),
  detail: z.string(),
  code: z.literal('price_changed'),
  lines: z.array(
    z.strictObject({
      position: z.number().int(),
      previous_quote_id: z.uuid(),
      /** The new quote to order with; null when the line can't be priced now. */
      quote: quoteSummaryResponseSchema.nullable(),
      reasons: z.array(quoteRefusalSchema),
    }),
  ),
});
export type PriceChangedResponse = z.infer<typeof priceChangedResponseSchema>;

export const COMMENT_MAX_LENGTH = 5000;
export const COMMENT_MAX_ATTACHMENTS = 10;

const commentAttachmentResponseSchema = z.strictObject({ file_version_id: z.uuid(), name: z.string() });

/** A comment as staff read it: who wrote it, and whether the partner holding the line reads it too. */
export const orderCommentResponseSchema = z.strictObject({
  id: z.uuid(),
  /** A line or sub-line of the order; null for the order as a whole. */
  line_id: z.uuid().nullable(),
  author: z.strictObject({ kind: z.enum(['staff', 'customer', 'partner']), id: z.uuid(), name: z.string() }),
  for_partner: z.boolean(),
  body: z.string(),
  attachments: z.array(commentAttachmentResponseSchema),
  created_at: z.string(),
});
export type OrderCommentResponse = z.infer<typeof orderCommentResponseSchema>;

/** A comment as the customer reads it: no partner's, none sent to a partner, and no staff-only flag. */
export const customerOrderCommentResponseSchema = z.strictObject({
  id: z.uuid(),
  line_id: z.uuid().nullable(),
  author: z.strictObject({ kind: z.enum(['staff', 'customer']), name: z.string() }),
  body: z.string(),
  attachments: z.array(commentAttachmentResponseSchema),
  created_at: z.string(),
});
export type CustomerOrderCommentResponse = z.infer<typeof customerOrderCommentResponseSchema>;
