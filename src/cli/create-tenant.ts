import { parseArgs } from 'node:util';
import { TenantService } from '../platform/tenant.service';
import { runCli } from './run-cli';

// npm run tenant:create -- --name=<name> --slug=<slug> --owner-email=<email>
//   [--currency=EUR] [--locale=en] [--timezone=UTC]
void runCli(async (app) => {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      slug: { type: 'string' },
      'owner-email': { type: 'string' },
      currency: { type: 'string', default: 'EUR' },
      locale: { type: 'string', default: 'en' },
      timezone: { type: 'string', default: 'UTC' },
    },
  });

  // Missing values are reported by validation alongside any other problem.
  const tenant = await app.get(TenantService).provision(
    {
      name: values.name ?? '',
      slug: values.slug ?? '',
      ownerEmail: values['owner-email'] ?? '',
      currency: values.currency,
      locale: values.locale,
      timezone: values.timezone,
    },
    { type: 'system' },
  );

  process.stdout.write(`${JSON.stringify(tenant)}\n`);
});
