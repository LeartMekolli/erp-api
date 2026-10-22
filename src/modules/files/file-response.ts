import { z } from 'zod';
import type { File, FileVersion, Measure } from '../../generated/prisma/client';

// The shapes below are what clients receive: the docs show them and the e2e
// tests check real responses against them. Nothing parses with them at runtime.

export const fileResponseSchema = z.strictObject({
  id: z.uuid(),
  kind: z.string(),
  name: z.string(),
  declared_unit: z.string().nullable(),
  owner: z.strictObject({ type: z.string(), id: z.string() }).nullable(),
  status: z.string(),
  created_at: z.string(),
});
export type FileResponse = z.infer<typeof fileResponseSchema>;

export const versionResponseSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int(),
  original_name: z.string(),
  content_type: z.string(),
  /** A number in JSON: FILE_MAX_BYTES keeps it far below 2^53. */
  size: z.number().int(),
  checksum: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});
export type VersionResponse = z.infer<typeof versionResponseSchema>;

/** `value` is a decimal string, never a float, so no precision is lost (ADR 0002 style). */
export const measureResponseSchema = z.strictObject({
  type: z.string(),
  value: z.string(),
  unit: z.string(),
});
export type MeasureResponse = z.infer<typeof measureResponseSchema>;

export const uploadResponseSchema = z.strictObject({
  url: z.string(),
  method: z.literal('PUT'),
  /** Exactly what the PUT must carry; the signature covers them all. */
  headers: z.strictObject({ 'content-type': z.string(), 'content-length': z.string() }),
  expires_at: z.string(),
});
export type UploadResponse = z.infer<typeof uploadResponseSchema>;

export const startUploadResponseSchema = z.strictObject({
  file: fileResponseSchema,
  version: versionResponseSchema,
  upload: uploadResponseSchema,
});

export const addVersionResponseSchema = z.strictObject({
  version: versionResponseSchema,
  upload: uploadResponseSchema,
});

export const fileDetailResponseSchema = fileResponseSchema.extend({
  versions: z.array(versionResponseSchema.extend({ measures: z.array(measureResponseSchema) })),
});

export const downloadUrlResponseSchema = z.strictObject({ url: z.string(), expires_at: z.string() });

export function toFileResponse(file: File): FileResponse {
  return {
    id: file.id,
    kind: file.kind,
    name: file.name,
    declared_unit: file.declaredUnit,
    owner: file.ownerType !== null && file.ownerId !== null ? { type: file.ownerType, id: file.ownerId } : null,
    status: file.status,
    created_at: file.createdAt.toISOString(),
  };
}

export function toVersionResponse(version: FileVersion): VersionResponse {
  return {
    id: version.id,
    number: version.number,
    original_name: version.originalName,
    content_type: version.contentType,
    size: Number(version.size),
    checksum: version.checksum,
    status: version.status,
    created_at: version.createdAt.toISOString(),
    completed_at: version.completedAt?.toISOString() ?? null,
  };
}

export function toMeasureResponse(measure: Measure): MeasureResponse {
  // toFixed() without digits never switches to exponent notation.
  return { type: measure.type, value: measure.value.toFixed(), unit: measure.unit };
}
