import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Logger } from 'pino';
import { LOGGER, createHttpLogger } from './common/logging/logger';
import { PinoLoggerService } from './common/logging/pino-logger.service';
import { requestIdMiddleware } from './common/request-context/request-id.middleware';
import { ConfigService } from './config/config.service';

/**
 * Everything that configures the HTTP application, applied identically by
 * `main.ts` and by end-to-end tests. Anything added here is covered by the
 * tests; anything added in `main.ts` alone is not.
 */
export function configureApp(app: INestApplication): void {
  app.useLogger(app.get(PinoLoggerService));

  // Behind a reverse proxy every socket address is the proxy's. This makes
  // req.ip (and so @Ip()) the client's, for exactly this many hops.
  (app as NestExpressApplication).set('trust proxy', app.get(ConfigService).get('TRUST_PROXY_HOPS'));

  // Order matters: the request logger reads the context the first one creates.
  app.use(requestIdMiddleware);
  app.use(createHttpLogger(app.get<Logger>(LOGGER)));
}
