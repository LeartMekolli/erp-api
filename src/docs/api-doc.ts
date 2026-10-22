import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';

export const API_DOC = 'docs:api-doc';

/** Values only known at runtime, for schemas built from configuration. */
export interface DocContext {
  fileMaxBytes: number;
}

/**
 * What the docs say about one route. Schemas are the ones the route validates
 * with (requests) or is typed from (responses), never written a second time.
 * Access is not here: it comes from the route marker.
 */
export interface ApiDocOptions {
  summary: string;
  description?: string;
  body?: z.ZodType | ((ctx: DocContext) => z.ZodType);
  query?: z.ZodObject;
  response?: z.ZodType;
  /**
   * Error statuses the route can answer, documented as problem+json. 401 and 403 on protected
   * routes, and 409 on tenant POSTs, are added by the builder.
   */
  errors?: number[];
}

/** Added by the document builder to every tenant POST, which IdempotencyInterceptor covers. */
export const IDEMPOTENCY_NOTE =
  'Accepts an `Idempotency-Key` header (1–255 visible ASCII characters): a repeat with the same key and request ' +
  'replays the first response; the same key with a different request is a 409.';

export const ApiDoc = (options: ApiDocOptions): MethodDecorator => SetMetadata(API_DOC, options);
