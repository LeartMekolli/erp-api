import { z } from 'zod';
import { paginationQuerySchema } from '../../../common/pagination/page';
import type { ReportExport } from '../../../generated/prisma/client';
import { EXPORT_KINDS } from './export-kinds';

export const exportStartedSchema = z.strictObject({ id: z.uuid() });

export const exportResponseSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(EXPORT_KINDS),
  params: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'ready', 'failed', 'expired']),
  /** Rows in a CSV; null for a PDF and until ready. */
  rows: z.number().int().min(0).nullable(),
  /** Why it failed, in plain words. */
  error: z.string().nullable(),
  created_at: z.iso.datetime(),
  finished_at: z.iso.datetime().nullable(),
  /** When the file is removed; downloads stop then. */
  expires_at: z.iso.datetime().nullable(),
  /** When a download link was first issued. */
  downloaded_at: z.iso.datetime().nullable(),
});
export type ExportResponse = z.infer<typeof exportResponseSchema>;

export const exportDownloadSchema = z.strictObject({ url: z.url(), expires_at: z.iso.datetime() });
export type ExportDownload = z.infer<typeof exportDownloadSchema>;

export const exportListQuerySchema = paginationQuerySchema;
export type ExportListQuery = z.infer<typeof exportListQuerySchema>;

export function toExportResponse(row: ReportExport): ExportResponse {
  return {
    id: row.id,
    kind: row.kind as ExportResponse['kind'],
    params: row.params as Record<string, unknown>,
    status: row.status as ExportResponse['status'],
    rows: row.rows,
    error: row.error,
    created_at: row.createdAt.toISOString(),
    finished_at: row.finishedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    downloaded_at: row.downloadedAt?.toISOString() ?? null,
  };
}
