/** What an error report carries beyond the error itself. */
export interface ErrorContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  /** Set for failures in the worker, which has no request. */
  jobId?: string;
  jobName?: string;
}

export interface ErrorReporter {
  report(error: unknown, context: ErrorContext): void;
}

/** Used when no DSN is configured: the filter's log is then the only record. */
export class NoopErrorReporter implements ErrorReporter {
  report(_error: unknown, _context: ErrorContext): void {
    // Intentionally empty.
  }
}

/**
 * The slice of the Sentry client this needs, kept deliberately loose so the
 * dependency stays swappable and testable with a plain object.
 */
export interface CaptureClient {
  captureException(error: unknown, hint?: unknown): unknown;
}

export class SentryErrorReporter implements ErrorReporter {
  constructor(private readonly client: CaptureClient) {}

  report(error: unknown, context: ErrorContext): void {
    try {
      // Extras travel under captureContext; Sentry's hint type rejects a bare
      // `extra` key.
      this.client.captureException(error, { captureContext: { extra: context } });
    } catch {
      // Reporting runs inside the exception filter, which must never throw:
      // a reporting outage would otherwise turn handled errors into crashes.
    }
  }
}
