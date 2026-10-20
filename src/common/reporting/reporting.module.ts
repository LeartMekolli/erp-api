import { Global, Module } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { ConfigService } from '../../config/config.service';
import { CaptureClient, ErrorReporter, NoopErrorReporter, SentryErrorReporter } from './error-reporter';

export const ERROR_REPORTER = Symbol('ERROR_REPORTER');

/** The slice of the Sentry SDK used here, so a test can pass a plain object. */
export interface SentryLike extends CaptureClient {
  init(options: { dsn: string; environment: string }): unknown;
}

/**
 * Picks the reporter once, at boot. Without a DSN nothing is initialised, so
 * local runs and tests never reach out to a network.
 */
export function createErrorReporter(config: ConfigService, sentry: SentryLike = Sentry): ErrorReporter {
  const dsn = config.get('SENTRY_DSN');
  if (!dsn) {
    return new NoopErrorReporter();
  }
  sentry.init({ dsn, environment: config.get('SENTRY_ENVIRONMENT') ?? config.get('NODE_ENV') });
  return new SentryErrorReporter(sentry);
}

@Global()
@Module({
  providers: [
    {
      provide: ERROR_REPORTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ErrorReporter => createErrorReporter(config),
    },
  ],
  exports: [ERROR_REPORTER],
})
export class ReportingModule {}
