import type { IncomingMessage } from 'node:http';
import pino, { DestinationStream, Logger } from 'pino';
import { pinoHttp, HttpLogger } from 'pino-http';
import { ConfigService } from '../../config/config.service';
import { requestContext, requestContextOf } from '../request-context/request-context';

export const LOGGER = Symbol('LOGGER');
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

/**
 * JSON lines carrying the current request, tenant and user ids. Request lines
 * (they carry `res`) get those from the request logger instead, so the mixin
 * stays out of their way rather than writing the keys twice.
 */
export function createLogger(config: ConfigService, destination: DestinationStream): Logger {
  return pino(
    {
      level: config.get('LOG_LEVEL'),
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: (mergeObject) => ('res' in mergeObject ? {} : { ...requestContext.getStore() }),
    },
    destination,
  );
}

function pathOnly(url: unknown): string | undefined {
  return typeof url === 'string' ? url.split('?')[0] : undefined;
}

/**
 * One line per request. The serializers are an allow-list: method, path and
 * status only, so headers (authorization, cookies), bodies and query strings
 * never reach the log, whatever a client sends. `redact` is a second guard in
 * case a serializer is ever widened.
 */
export function createHttpLogger(logger: Logger): HttpLogger {
  return pinoHttp({
    logger,
    // Added once, to the completion line. (customProps would be applied both
    // when the request starts and when it finishes, writing the keys twice.)
    customSuccessObject: (request: IncomingMessage, _response, line: object) => ({
      ...requestContextOf(request),
      ...line,
    }),
    customErrorObject: (request: IncomingMessage, _response, _error, line: object) => ({
      ...requestContextOf(request),
      ...line,
    }),
    customLogLevel: (_request, response, error) =>
      error || response.statusCode >= 500 ? 'error' : 'info',
    serializers: {
      req: (request: { method?: string; url?: string }) => ({
        method: request.method,
        url: pathOnly(request.url),
      }),
      res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
    },
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  });
}
