import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

/** passwordHash, keyHash, token_hash, password, clientSecret, ... — not access_token. */
const CREDENTIAL_KEY = /(hash|password|secret)$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A copy of `value` without credential-named properties, at any depth. */
export function stripCredentials<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => stripCredentials(item)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const copy: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!CREDENTIAL_KEY.test(key)) {
      copy[key] = stripCredentials(inner);
    }
  }
  return copy as T;
}

/**
 * The second line of defence behind the response mappers, which are
 * allow-lists already (spec 4.8): a hash that slips into a response body is
 * removed here instead of reaching a client.
 */
@Injectable()
export class StripCredentialsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body: unknown) => stripCredentials(body)));
  }
}
