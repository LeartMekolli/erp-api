import { z } from 'zod';
import type { TenantPermission } from '../../identity/permissions';
import { ORDER_STATES } from '../../orders/order-response';
import { PARTNER_STATUSES } from '../../partners/partner-response';
import type { CsvCell, CsvColumn } from './csv';

/** What staff may export (Reporting 2 spec); the database checks the same list. */
export const EXPORT_KINDS = [
  'customers',
  'orders',
  'partners',
  'accounting_invoices',
  'accounting_payments',
  'accounting_refunds',
  'accounting_payouts',
  'dashboard_pdf',
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** The permission of the screen each kind's data comes from, needed on top of `report.export`. */
export const EXPORT_PERMISSION: Record<ExportKind, TenantPermission> = {
  customers: 'customer.read',
  orders: 'order.read',
  partners: 'partner.read',
  accounting_invoices: 'payment.read',
  accounting_payments: 'payment.read',
  accounting_refunds: 'payment.read',
  accounting_payouts: 'payment.read',
  dashboard_pdf: 'report.read',
};

/** The most rows one CSV export may hold (Reporting 2 spec, goal 9). */
export const EXPORT_ROW_LIMIT = 100_000;

/** A range of calendar dates in the workspace's time zone, both ends included. */
const dateRange = { from: z.iso.date(), to: z.iso.date() };
const toNotBeforeFrom = (range: { from?: string; to?: string }) => !range.from || !range.to || range.to >= range.from;

export const customersParamsSchema = z
  .strictObject({ from: dateRange.from.optional(), to: dateRange.to.optional() })
  .refine(toNotBeforeFrom, { message: '`to` is before `from`', path: ['to'] })
  .refine((range) => (range.from === undefined) === (range.to === undefined), { message: 'Give both `from` and `to`, or neither' });

/** The most days a range may span, both ends counted (Reporting 2 spec). */
export const MAX_RANGE_DAYS = 366;
const spanDays = (range: { from: string; to: string }) =>
  (new Date(`${range.to}T00:00:00Z`).getTime() - new Date(`${range.from}T00:00:00Z`).getTime()) / 86_400_000 + 1;
const withinMaxRange = (range: { from: string; to: string }) => range.to < range.from || spanDays(range) <= MAX_RANGE_DAYS;

export const ordersParamsSchema = z
  .strictObject({
    ...dateRange,
    customer_id: z.uuid().optional(),
    states: z.array(z.enum(ORDER_STATES)).min(1).optional(),
  })
  .refine(toNotBeforeFrom, { message: '`to` is before `from`', path: ['to'] })
  .refine(withinMaxRange, { message: `At most ${MAX_RANGE_DAYS} days`, path: ['to'] });

export const partnersParamsSchema = z.strictObject({ status: z.enum(PARTNER_STATUSES).optional() });

/**
 * A calendar month, `YYYY-MM`, not in the future. "Now" is taken 14 hours ahead of UTC, so a workspace in
 * any time zone may ask for the month it is already in.
 */
export const accountingParamsSchema = z.strictObject({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month as YYYY-MM')
    .refine((month) => month <= new Date(Date.now() + 14 * 3_600_000).toISOString().slice(0, 7), 'A month not in the future'),
});

/** One request per kind; later kinds join this union as they are built. */
export const exportRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('customers'), params: customersParamsSchema.default({}) }),
  z.strictObject({ kind: z.literal('orders'), params: ordersParamsSchema }),
  z.strictObject({ kind: z.literal('partners'), params: partnersParamsSchema.default({}) }),
  z.strictObject({ kind: z.literal('accounting_invoices'), params: accountingParamsSchema }),
  z.strictObject({ kind: z.literal('accounting_payments'), params: accountingParamsSchema }),
  z.strictObject({ kind: z.literal('accounting_refunds'), params: accountingParamsSchema }),
  z.strictObject({ kind: z.literal('accounting_payouts'), params: accountingParamsSchema }),
]);
export type ExportRequest = z.infer<typeof exportRequestSchema>;

/** What a builder gets: the parameters asked with and the asker's permissions when asked. */
export interface ExportContext<P = unknown> {
  tenantId: string;
  params: P;
  may: ReadonlySet<TenantPermission>;
  timeZone: string;
  currency: string;
}

/** A CSV kind: its columns for what the asker may see, and its rows in pages. */
export interface CsvBuilder<P = unknown> {
  kind: ExportKind;
  format: 'csv';
  columns(may: ReadonlySet<TenantPermission>): CsvColumn[];
  pages(ctx: ExportContext<P>): AsyncIterable<Record<string, CsvCell>[]>;
}

/** A PDF kind: the whole document. */
export interface PdfBuilder<P = unknown> {
  kind: ExportKind;
  format: 'pdf';
  document(ctx: ExportContext<P>): Promise<Buffer>;
}

export type ExportBuilder = CsvBuilder | PdfBuilder;

/** Rows are read in pages of this many, each page its own short transaction. */
export const PAGE_SIZE = 1_000;
