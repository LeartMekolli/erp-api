import { z } from 'zod';
import type { TenantPermission } from '../../identity/permissions';
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

/** One request per kind; later kinds join this union as they are built. */
export const exportRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('customers'), params: customersParamsSchema.default({}) }),
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
