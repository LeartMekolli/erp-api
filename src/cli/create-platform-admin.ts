import { parseArgs } from 'node:util';
import { PrismaService } from '../database/prisma.service';
import { createPlatformAdmin } from './platform-admins';
import { runCli } from './run-cli';

// npm run platform-admin:create -- --email=<email> [--name="Platform Admin"]
void runCli(async (app) => {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string', default: 'Platform Admin' },
    },
  });

  const created = await createPlatformAdmin(app.get(PrismaService), {
    email: values.email ?? '',
    name: values.name,
  });

  if (!created) {
    throw new Error(`A platform admin with email ${values.email ?? ''} already exists.`);
  }

  // Shown once and stored nowhere but as a hash.
  process.stdout.write(`${JSON.stringify(created)}\n`);
});
