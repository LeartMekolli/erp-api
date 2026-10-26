import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';

/**
 * The one response body for every failure, serialised as
 * `application/problem+json` (RFC 9457).
 *
 * `type` is the machine-readable part: clients branch on it rather than on
 * message text, so wording stays free to change.
 */
export interface ApiError {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
  /** Names a refusal clients act on, such as `price_changed`; its extension members come with it. */
  code?: string;
  [extension: string]: unknown;
}

const titles: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

function titleFor(status: number): string {
  return titles[status] ?? 'Error';
}

function detailOf(exception: HttpException): string | undefined {
  const response: unknown = exception.getResponse();

  if (typeof response === 'string') {
    return response;
  }

  const message = (response as { message?: unknown }).message;
  if (typeof message === 'string') {
    return message;
  }
  // Nest's built-in exceptions can carry an array of messages.
  if (Array.isArray(message)) {
    return message.filter((part): part is string => typeof part === 'string').join('; ');
  }

  return undefined;
}

/** A refusal we wrote can name each thing it refuses: `new ConflictException({ message, errors })`. */
function errorsOf(exception: HttpException): ApiError['errors'] {
  const response: unknown = exception.getResponse();
  const errors = typeof response === 'object' && response !== null ? (response as { errors?: unknown }).errors : undefined;
  if (!Array.isArray(errors)) {
    return undefined;
  }
  return errors
    .filter((entry): entry is { path: unknown; message: unknown } => typeof entry === 'object' && entry !== null)
    .map((entry) => ({ path: String(entry.path), message: String(entry.message) }));
}

/**
 * A refusal with a `code` carries what the client needs to act on it as extension members (RFC 9457):
 * `new ConflictException({ code: 'price_changed', message, lines })` answers `code` and `lines`.
 * Without a `code`, nothing beyond `message` and `errors` is passed on.
 */
function extensionsOf(exception: HttpException): Record<string, unknown> {
  const response: unknown = exception.getResponse();
  if (typeof response !== 'object' || response === null) {
    return {};
  }
  if (typeof (response as { code?: unknown }).code !== 'string') {
    return {};
  }
  // Nest's own members and the problem's are never passed on as extensions.
  const reserved = new Set(['message', 'errors', 'statusCode', 'error', 'type', 'title', 'status', 'detail']);
  return Object.fromEntries(Object.entries(response).filter(([key]) => !reserved.has(key)));
}

/**
 * Converts anything thrown into an `ApiError`.
 *
 * Messages we wrote (Nest exceptions) are shown to the caller. Anything else is
 * replaced with a generic detail: an unexpected error's text can carry schema
 * names, file paths or credentials, and none of that belongs in a response.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ZodError) {
    return {
      type: 'urn:problem:validation',
      title: 'Validation failed',
      status: 400,
      errors: error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    };
  }

  if (error instanceof HttpException) {
    const status = error.getStatus();
    const errors = errorsOf(error);
    return {
      ...extensionsOf(error),
      type: 'about:blank',
      title: titleFor(status),
      status,
      detail: detailOf(error),
      ...(errors ? { errors } : {}),
    };
  }

  return {
    type: 'about:blank',
    title: 'Internal Server Error',
    status: 500,
    detail: 'An unexpected error occurred.',
  };
}
