import { ArgumentsHost, Catch, ExceptionFilter, Inject, Logger, Optional } from '@nestjs/common';
import { Response } from 'express';
import { ERROR_REPORTER } from '../reporting/reporting.module';
import { ErrorReporter, NoopErrorReporter } from '../reporting/error-reporter';
import { ApiError, toApiError } from './api-error';

/**
 * Catches everything and writes one response shape. Registered as an
 * `APP_FILTER` provider so it can take injected dependencies.
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiErrorFilter.name);
  private readonly reporter: ErrorReporter;

  constructor(@Optional() @Inject(ERROR_REPORTER) reporter?: ErrorReporter) {
    // Optional so a module can import the error shape without the reporter.
    this.reporter = reporter ?? new NoopErrorReporter();
  }

  catch(error: unknown, host: ArgumentsHost): void {
    const apiError: ApiError = toApiError(error);

    // The caller gets a generic detail for a 500, so the real cause has to be
    // recorded here or it is lost entirely.
    if (apiError.status >= 500) {
      this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      this.reporter.report(error, {});
    }

    host
      .switchToHttp()
      .getResponse<Response>()
      .status(apiError.status)
      .type('application/problem+json')
      .send(apiError);
  }
}
