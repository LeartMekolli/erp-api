import { INestApplication } from '@nestjs/common';

/**
 * Everything that configures the HTTP application, applied identically by
 * `main.ts` and by end-to-end tests. Anything added here is covered by the
 * tests; anything added in `main.ts` alone is not.
 */
export function configureApp(app: INestApplication): void {
  // Health probes stay outside the version prefix: a load balancer should not
  // have to know the API's version to know whether the process is alive.
  app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
}
