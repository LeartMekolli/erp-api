/** What an error report carries beyond the error itself. */
export interface ErrorContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
}

export interface ErrorReporter {
  report(error: unknown, context: ErrorContext): void;
}

/** Used when no DSN is configured: the filter's log is then the only record. */
export class NoopErrorReporter implements ErrorReporter {
  report(): void {
    // Intentionally empty.
  }
}

/** The slice of the Sentry client this needs — keeps the dependency swappable. */
export interface CaptureClient {
  captureException(error: unknown, hint: { extra: ErrorContext }): unknown;
}

export class SentryErrorReporter implements ErrorReporter {
  constructor(private readonly client: CaptureClient) {}

  report(error: unknown, context: ErrorContext): void {
    try {
      this.client.captureException(error, { extra: context });
    } catch {
      // Reporting runs inside the exception filter, which must never throw:
      // a reporting outage would otherwise turn handled errors into crashes.
    }
  }
}
