import { applyE2eDefaults, withDatabase, workerDatabase } from './e2e-env';

applyE2eDefaults();

// Each jest worker has a database of its own (global-setup-e2e.ts): host, port and credentials stay as set,
// only the database changes.
const database = workerDatabase(process.env.JEST_WORKER_ID ?? '1');
for (const key of ['DATABASE_URL', 'DATABASE_MIGRATE_URL'] as const) {
  const url = process.env[key];
  if (url) process.env[key] = withDatabase(url, database);
}
