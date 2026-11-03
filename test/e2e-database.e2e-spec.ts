import { Client } from 'pg';
import { workerDatabase } from './e2e-env';

describe('e2e databases', () => {
  it('gives each jest worker a migrated database of its own', async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ name: string; user: string; migrated: boolean }>(
        `SELECT current_database() AS name, current_user AS "user", to_regclass('public._prisma_migrations') IS NOT NULL AS migrated`,
      );
      expect(rows[0]).toEqual({ name: workerDatabase(process.env.JEST_WORKER_ID ?? '1'), user: 'erp_app', migrated: true });
      expect(rows[0].name).not.toBe('erp');
    } finally {
      await client.end();
    }
  });
});
