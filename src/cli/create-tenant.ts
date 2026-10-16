import { parseArgs } from 'node:util';
import { TenantService } from '../platform/tenant.service';
import { runCli } from './run-cli';

// npm run tenant:create -- --name=<name> --slug=<slug> [--currency=EUR] [--locale=en] [--timezone=UTC]
void runCli(async (app) => {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      slug: { type: 'string' },
      currency: { type: 'string', default: 'EUR' },
      locale: { type: 'string', default: 'en' },
      timezone: { type: 'string', default: 'UTC' },
    },
  });

  // A missing name or slug is reported by validation alongside any other problem.
  const tenant = await app.get(TenantService).create({
    name: values.name ?? '',
    slug: values.slug ?? '',
    currency: values.currency,
    locale: values.locale,
    timezone: values.timezone,
  });

  process.stdout.write(`${JSON.stringify(tenant)}\n`);
});
