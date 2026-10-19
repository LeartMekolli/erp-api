import type { Readable } from 'node:stream';

export const STORAGE = Symbol('STORAGE');

/**
 * Private object storage (D60). Files enter and leave only through signed
 * URLs; the API itself only signs, checks with HEAD, and (in the worker) reads.
 * Keys are built by the caller from ids alone, never from a client's name.
 */
export interface ObjectStorage {
  /** A PUT URL that accepts exactly this content type and length. */
  presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<string>;

  /**
   * A GET URL whose response carries `contentType` and a `Content-Disposition`
   * built from `fileName` (plan S8).
   */
  presignGet(
    key: string,
    options: { fileName: string; contentType: string; expiresInSeconds: number },
  ): Promise<string>;

  /** The stored size and type, or `null` when nothing is stored under `key`. */
  head(key: string): Promise<{ size: number; contentType: string } | null>;

  /** Streams the object; the caller consumes or destroys the stream. */
  read(key: string): Promise<Readable>;
}
