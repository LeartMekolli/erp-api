import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { applyE2eDefaults, templateDatabase, withDatabase, workerDatabase } from './e2e-env';

/**
 * Before any spec: migrates a template database, then gives each jest worker a copy of it, so a spec working
 * through every workspace never reaches another worker's specs. Only databases named here are dropped; the
 * developer's own `erp` is the connection the commands are issued from, never touched.
 */
export default async function globalSetup(config: { maxWorkers: number }): Promise<void> {
  applyE2eDefaults();
  const migrateUrl = process.env.DATABASE_MIGRATE_URL;
  if (!migrateUrl) throw new Error('DATABASE_MIGRATE_URL is not set');

  const admin = new Client({ connectionString: migrateUrl });
  await admin.connect();
  try {
    await recreate(admin, templateDatabase);
    execFileSync('node_modules/.bin/prisma', ['migrate', 'deploy'], {
      env: { ...process.env, DATABASE_MIGRATE_URL: withDatabase(migrateUrl, templateDatabase) },
      stdio: 'pipe',
    });
    for (let worker = 1; worker <= config.maxWorkers; worker += 1) {
      await recreate(admin, workerDatabase(worker), templateDatabase);
    }
  } finally {
    await admin.end();
  }
}

/** Names are built in e2e-env.ts from hex and digits only, so quoting them is enough. */
async function recreate(admin: Client, name: string, template?: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ''}`);
  await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO erp_app`);
}
