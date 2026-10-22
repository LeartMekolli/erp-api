import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import type { Logger } from 'pino';
import { LOGGER, createHttpLogger } from './common/logging/logger';
import { PinoLoggerService } from './common/logging/pino-logger.service';
import { requestIdMiddleware } from './common/request-context/request-id.middleware';
import { ConfigService } from './config/config.service';
import { buildOpenApiDocument } from './docs/openapi-document';

/**
 * Everything that configures the HTTP application, applied identically by
 * `main.ts` and by end-to-end tests. Anything added here is covered by the
 * tests; anything added in `main.ts` alone is not.
 */
export function configureApp(app: INestApplication): void {
  app.useLogger(app.get(PinoLoggerService));

  // Behind a reverse proxy every socket address is the proxy's. This makes
  // req.ip (and so @Ip()) the client's, for exactly this many hops.
  const config = app.get(ConfigService);
  (app as NestExpressApplication).set('trust proxy', config.get('TRUST_PROXY_HOPS'));

  const origins = config.get('CORS_ORIGINS');
  if (origins.length > 0) {
    app.enableCors({ origin: origins, credentials: false, maxAge: 600 });
  }

  // Order matters: the request logger reads the context the first one creates.
  app.use(requestIdMiddleware);
  app.use(createHttpLogger(app.get<Logger>(LOGGER)));

  // Built on first request, once every module is initialised.
  if (config.get('API_DOCS')) {
    SwaggerModule.setup('docs', app, () => buildOpenApiDocument(app), {
      jsonDocumentUrl: 'docs/openapi.json',
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // SIGTERM (every deploy and spin-down on Render) and SIGINT close the
  // application: queue consumers wait for active jobs, then the database pool
  // and Redis disconnect.
  app.enableShutdownHooks();
}
