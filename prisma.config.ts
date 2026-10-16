// The Prisma CLI runs this file outside the application, so nothing has loaded
// `.env` for it. In CI and production the variables are already in the
// environment and this import is a no-op.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma CLI configuration (Prisma 7 moved connection URLs out of the schema).
 *
 * Migrate connects as erp_owner, the table owner, so it can run DDL. Tenant
 * tables force row-level security, so the owner sees their rows only with a
 * tenant set. The running application uses DATABASE_URL (erp_app) through its
 * driver adapter instead. See ADR 0001.
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
