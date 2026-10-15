import { Global, Module } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { ConfigService } from '../../config/config.service';
import { ErrorReporter, NoopErrorReporter, SentryErrorReporter } from './error-reporter';

export const ERROR_REPORTER = Symbol('ERROR_REPORTER');

/**
 * Picks the reporter once, at boot. Without a DSN nothing is initialised, so
 * local runs and tests never reach out to a network.
 */
@Global()
@Module({
  providers: [
    {
      provide: ERROR_REPORTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ErrorReporter => {
        const dsn = config.get('SENTRY_DSN');
        if (!dsn) {
          return new NoopErrorReporter();
        }
        Sentry.init({ dsn, environment: config.get('NODE_ENV') });
        return new SentryErrorReporter(Sentry);
      },
    },
  ],
  exports: [ERROR_REPORTER],
})
export class ReportingModule {}
