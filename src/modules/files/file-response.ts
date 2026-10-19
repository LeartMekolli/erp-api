import type { File, FileVersion, Measure } from '../../generated/prisma/client';
import type { SignedPutHeaders } from '../../storage/object-storage';

export interface FileResponse {
  id: string;
  kind: string;
  name: string;
  declared_unit: string | null;
  owner: { type: string; id: string } | null;
  status: string;
  created_at: string;
}

export interface VersionResponse {
  id: string;
  number: number;
  original_name: string;
  content_type: string;
  /** A number in JSON: FILE_MAX_BYTES keeps it far below 2^53. */
  size: number;
  checksum: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
}

/** `value` is a decimal string, never a float, so no precision is lost (ADR 0002 style). */
export interface MeasureResponse {
  type: string;
  value: string;
  unit: string;
}

export interface UploadResponse {
  url: string;
  method: 'PUT';
  /** Exactly what the PUT must carry; the signature covers them all. */
  headers: SignedPutHeaders;
  expires_at: string;
}

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
