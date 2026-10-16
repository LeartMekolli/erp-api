// The Prisma CLI runs this file outside the application, so nothing has loaded
// `.env` for it. In CI and production the variables are already in the
// environment and this import is a no-op.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma CLI configuration (Prisma 7 moved connection URLs out of the schema).
 *
 * Migrate connects as erp_owner — the table owner, which row-level security
 * does not apply to. The running application uses DATABASE_URL (erp_app)
 * through its driver adapter instead. See ADR 0001.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_MIGRATE_URL'),
  },
});
