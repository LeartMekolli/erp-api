import { NoopErrorReporter, SentryErrorReporter } from './error-reporter';

describe('error reporting', () => {
  it('does nothing, and does not throw, when no DSN is configured', () => {
    const reporter = new NoopErrorReporter();

    expect(() => reporter.report(new Error('boom'), { requestId: 'r1' })).not.toThrow();
  });

  it('forwards the error with its context', () => {
    const captureException = jest.fn();
    const reporter = new SentryErrorReporter({ captureException });
    const error = new Error('boom');

    reporter.report(error, { requestId: 'r1', tenantId: 't1' });

    expect(captureException).toHaveBeenCalledWith(error, {
      captureContext: { extra: { requestId: 'r1', tenantId: 't1' } },
    });
  });

  it('swallows a reporting failure rather than masking the original error', () => {
    const reporter = new SentryErrorReporter({
      captureException: () => {
        throw new Error('the reporting service is down');
      },
    });

    expect(() => reporter.report(new Error('boom'), {})).not.toThrow();
  });
});
