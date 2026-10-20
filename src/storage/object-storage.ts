import type { Readable } from 'node:stream';

export const STORAGE = Symbol('STORAGE');

/** A type, not an interface, so it also fits `Record<string, string>`. */
export type SignedPutHeaders = {
  'content-type': string;
  'content-length': string;
};

export interface StoredObject {
  size: number;
  contentType: string;
  /** Opaque, quotes included, exactly as storage returns it. Pass it back to `copy`. */
  etag: string;
}

/** The source of a copy does not exist. */
export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`No object under ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

/** The source of a copy is no longer the object whose ETag was given. */
export class ObjectChangedError extends Error {
  constructor(key: string) {
    super(`Object ${key} changed since it was checked`);
    this.name = 'ObjectChangedError';
  }
}

/**
 * Private object storage (D60). Files enter and leave only through signed
 * URLs; the API itself signs, checks with HEAD, copies and deletes server-side,
 * and (in the worker) reads.
 * Keys are built by the caller from ids alone, never from a client's name.
 */
export interface ObjectStorage {
  /**
   * A PUT URL that accepts exactly this content type and length, until it
   * expires. `headers` are what the PUT must carry; the signature covers them.
   */
  presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<{ url: string; headers: SignedPutHeaders }>;

  /**
   * A GET URL whose response carries `contentType` and a `Content-Disposition`
   * built from `fileName` (plan S8).
   */
  presignGet(
    key: string,
    options: { fileName: string; contentType: string; expiresInSeconds: number },
  ): Promise<string>;

  /** The stored size, type and ETag, or `null` when nothing is stored under `key`. */
  head(key: string): Promise<StoredObject | null>;

  /**
   * Server-side copy: no bytes pass through the API. Replaces `to`. With
   * `ifMatchEtag`, copies only if `from` still has that ETag.
   */
  copy(from: string, to: string, options?: { ifMatchEtag?: string }): Promise<void>;

  /** Deletes `key`; already gone is not an error. */
  delete(key: string): Promise<void>;

  /** Streams the object; the caller consumes or destroys the stream. */
  read(key: string): Promise<Readable>;
}
