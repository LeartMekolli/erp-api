import { z } from 'zod';
import { TRACKING_STATUSES } from '../couriers/courier-provider';
import { INVOICE_STATUSES, PAYMENT_STATES, PAYMENT_TERMS } from '../payments/payment-state';
import { quoteRefusalSchema, quoteSummaryResponseSchema } from '../pricing/quote-response';
import { customerViewResponseSchema } from '../workflow/work-order-response';
import { linePicksSchema } from './line-picks';
import { NEEDS_REASONS } from './needs';

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

/** A parcel as staff measure it: grams and centimetres (Orders 3 spec, "My calls"). */
export const parcelSchema = z.strictObject({
  weight_g: z.number().int().min(1).max(100_000),
  length_cm: z.number().int().min(1).max(500),
  width_cm: z.number().int().min(1).max(500),
  height_cm: z.number().int().min(1).max(500),
});

const courierName = z.string().trim().min(1).max(100);
/** The courier service's carrier and service a live-rate method is priced and labelled by. */
export const liveRateSchema = z.strictObject({ carrier: courierName, service: courierName });

/** A label to buy (Orders 3 spec, goal 23); each left out comes from the order's shipping method. */
export const labelRequestSchema = z.strictObject({
  /** The method's default parcel when left out. */
  parcel: parcelSchema.optional(),
  /** The method's live-rate carrier and service when left out. */
  carrier: courierName.optional(),
  service: courierName.optional(),
});
export type LabelRequest = z.infer<typeof labelRequestSchema>;

/** The courier's last tracking state of a label, null until the first update. */
export const trackingStatusSchema = z.enum(TRACKING_STATUSES).nullable();

/** A bought label as staff see it. */
export const labelResponseSchema = z.strictObject({
  /** The courier service's hosted label, to print. */
  url: z.string(),
  carrier: z.string(),
  service: z.string(),
  tracking: z.string(),
  tracking_status: trackingStatusSchema,
  /** What the label cost, in `currency`. */
  cost: z.string(),
  currency: z.string(),
});
export type LabelResponse = z.infer<typeof labelResponseSchema>;

export const shippingMethodResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** Per order, in the workspace's currency; null for a live-rate method, priced for each order. */
  price: z.string().nullable(),
  /** The courier service's carrier and service a live-rate method is priced by; null for a fixed price. */
  live_rate: liveRateSchema.nullable(),
  /** The parcel a live rate is asked for, and a label's default. */
  default_parcel: parcelSchema.nullable(),
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
  /** What credit notes took off it, so far less is due (Orders 3 spec, goal 3). */
  credited: money,
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

/**
 * The partner holding a line or part, and whether it has accepted (Order detail spec, goal 2).
 * `expires_at` is an open offer's deadline, kept as it was until the expiry run lets it go; null once
 * accepted, or for a direct job.
 */
export const linePartnerSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(['offered', 'accepted']),
  expires_at: z.iso.datetime().nullable(),
});
export type LinePartner = z.infer<typeof linePartnerSchema>;

/** What a line or part was ordered with, as it was named when the order was placed (Order detail spec, goal 1). */
export const linePicksResponseSchema = z.strictObject({
  options: linePicksSchema.shape.options,
  size: linePicksSchema.shape.size,
  /** The quote's file, else the product's own; null when neither. */
  design_file: linePicksSchema.shape.design_file.unwrap().omit({ customer_owned: true }).nullable(),
});
export type LinePicksResponse = z.infer<typeof linePicksResponseSchema>;

export const orderLineResponseSchema = z.strictObject({
  id: z.uuid(),
  /** From 0, in the order the lines were placed. */
  position: z.number().int(),
  product: z.strictObject({ id: z.uuid(), name: z.string() }),
  quantity: z.number().int(),
  unit_price: z.string(),
  total: z.string(),
  ...linePicksResponseSchema.shape,
  /** Derived from the line's pieces. */
  state: z.enum(LINE_STATES),
  /** The work order group the line is made as. */
  group_id: z.uuid().nullable(),
  /** The partner holding the line, offered or accepted; null while it is made in-house. */
  partner: linePartnerSchema.nullable(),
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
      /** The options of the assembly's groups the part has, its own size, and its own pinned file. */
      ...linePicksResponseSchema.shape,
      state: z.enum(LINE_STATES),
      group_id: z.uuid().nullable(),
      partner: linePartnerSchema.nullable(),
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
  /** Decided by the lines, payment and shipping; stored, and kept current by every change. */
  state: z.enum(ORDER_STATES),
  /** The day the order is promised for, in the workspace's calendar. */
  promised_on: z.iso.date(),
  /** Why the order needs staff today, in this order; empty when nothing does (Orders list spec, goal 12). */
  needs: z.array(z.enum(NEEDS_REASONS)),
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
    /** The label bought when it shipped; null when shipped without one, or not yet. */
    label: labelResponseSchema.nullable(),
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
  /** The staff member, or the customer's own person for an order from the customer app (`channel`). */
  placed_by: z.strictObject({ id: z.uuid(), name: z.string() }),
  /** When and why, once every line is cancelled; null otherwise (Order detail spec, goal 3). */
  cancelled: z.strictObject({ at: z.iso.datetime(), reason: z.string().nullable() }).nullable(),
  payment: orderPaymentResponseSchema,
});
export type OrderResponse = z.infer<typeof orderResponseSchema>;

const count = z.number().int().min(0);
/** How many orders each tab and each needs-you reason holds (Orders list spec, goal 13). */
export const orderCountsResponseSchema = z.strictObject({
  /** Every order the filters pick, computed or not. */
  all: count,
  /** Per stored state; an order not computed yet is in none. */
  states: z.strictObject(Object.fromEntries(ORDER_STATES.map((state) => [state, count])) as Record<(typeof ORDER_STATES)[number], typeof count>),
  /** Per reason; `total` counts an order matching several reasons once. */
  needs_you: z.strictObject({ total: count, ...Object.fromEntries(NEEDS_REASONS.map((reason) => [reason, count])) } as Record<
    'total' | (typeof NEEDS_REASONS)[number],
    typeof count
  >),
  /**
   * What is still owed on the orders `needs_you.to_collect` counts, per currency, sorted by it: the open
   * invoice less issued credit notes, or the order total before billing, less what was paid. A currency
   * owing nothing is left out.
   */
  to_collect_amounts: z.array(z.strictObject({ currency: z.string(), amount: z.string().describe('With two decimals.') })),
});
export type OrderCountsResponse = z.infer<typeof orderCountsResponseSchema>;

/**
 * What shipping several orders at once answers, one result per order in the request's order: the order as
 * shipping it alone answers, or what shipping it alone would have refused it with.
 */
export const bulkShipResponseSchema = z.strictObject({
  results: z.array(
    z.discriminatedUnion('result', [
      z.strictObject({ order_id: z.uuid(), result: z.literal('shipped'), order: orderResponseSchema }),
      z.strictObject({
        order_id: z.uuid(),
        result: z.literal('failed'),
        error: z.strictObject({
          /** The status shipping the order alone would have answered. */
          status: z.number().int(),
          /** Its problem code, such as `order_already_shipped`, when it has one. */
          code: z.string().nullable(),
          detail: z.string(),
        }),
      }),
    ]),
  ),
});
export type BulkShipResponse = z.infer<typeof bulkShipResponseSchema>;

/** The shipping methods a customer can choose for a new order: only the active ones. */
export const portalShippingMethodsResponseSchema = z.strictObject({
  data: z.array(shippingMethodResponseSchema.pick({ key: true, name: true, price: true })),
});
export type PortalShippingMethodsResponse = z.infer<typeof portalShippingMethodsResponseSchema>;

/**
 * A line as its customer sees it: no partner and no work order group, with the stages the customer may
 * see; its design file only when it is the customer's own (Order detail spec, goal 6).
 */
export const customerOrderLineResponseSchema = orderLineResponseSchema.omit({ group_id: true, partner: true }).extend({
  progress: customerViewResponseSchema,
  /** What an assembly is made of, and how far each part is; never a part's price or who makes it. */
  parts: z.array(
    z.strictObject({
      position: z.number().int(),
      product: z.strictObject({ id: z.uuid(), name: z.string() }),
      quantity: z.number().int(),
      options: linePicksResponseSchema.shape.options,
      size: linePicksResponseSchema.shape.size,
      state: z.enum(LINE_STATES),
      progress: customerViewResponseSchema,
    }),
  ),
});
export type CustomerOrderLineResponse = z.infer<typeof customerOrderLineResponseSchema>;

/** An order as its customer sees it (Global Constraints): never a partner, a partner's cost or a margin. */
export const customerOrderResponseSchema = orderResponseSchema.omit({ customer: true, channel: true, needs: true, placed_by: true, cancelled: true }).extend({
  /** Never the label or what it cost; how the parcel is doing instead. */
  shipping: orderResponseSchema.shape.shipping.omit({ label: true }).extend({ tracking_status: trackingStatusSchema }),
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

/** Who reads a comment besides staff: the customer, the partner holding its line, or nobody. */
export const COMMENT_VISIBILITIES = ['customer', 'partner', 'staff'] as const;
export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];

const commentAttachmentResponseSchema = z.strictObject({ file_version_id: z.uuid(), name: z.string() });

/** A comment as staff read it: who wrote it, and who else reads it. */
export const orderCommentResponseSchema = z.strictObject({
  id: z.uuid(),
  /** A line or sub-line of the order; null for the order as a whole. */
  line_id: z.uuid().nullable(),
  author: z.strictObject({ kind: z.enum(['staff', 'customer', 'partner']), id: z.uuid(), name: z.string() }),
  /** Who reads it besides staff. A customer's own comment is `customer`, a partner's own is `partner`. */
  visibility: z.enum(COMMENT_VISIBILITIES),
  body: z.string(),
  attachments: z.array(commentAttachmentResponseSchema),
  created_at: z.string(),
});
export type OrderCommentResponse = z.infer<typeof orderCommentResponseSchema>;

/** A comment as the customer reads it: only those for the customer, and no `visibility`. */
export const customerOrderCommentResponseSchema = z.strictObject({
  id: z.uuid(),
  line_id: z.uuid().nullable(),
  author: z.strictObject({ kind: z.enum(['staff', 'customer']), name: z.string() }),
  body: z.string(),
  attachments: z.array(commentAttachmentResponseSchema),
  created_at: z.string(),
});
export type CustomerOrderCommentResponse = z.infer<typeof customerOrderCommentResponseSchema>;
