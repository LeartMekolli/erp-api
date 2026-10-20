import { Logger } from '@nestjs/common';
import { createConfigService } from '../src/config/config.service';
import { PrismaService } from '../src/database/prisma.service';
import { waitFor } from './wait-for';

describe('database connections that drop while idle', () => {
  const name = 'e2e-pool-error';
  let victim: PrismaService;
  let killer: PrismaService;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.searchParams.set('application_name', name);
    victim = new PrismaService(createConfigService({ ...process.env, DATABASE_URL: url.toString() }));
    killer = new PrismaService(createConfigService());
    await Promise.all([victim.onModuleInit(), killer.onModuleInit()]);
  });

  afterAll(async () => {
    await Promise.all([victim?.onModuleDestroy(), killer?.onModuleDestroy()]);
  });

  it('survives the server closing an idle connection, logs it, and serves the next query', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    try {
      await victim.$queryRaw`SELECT 1`; // opens a pooled connection and leaves it idle

      // The server side drops it, as a suspending Neon compute would. Same role,
      // so erp_app may terminate it.
      await killer.$queryRaw`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${name}`;

      await waitFor(() =>
        Promise.resolve(
          warn.mock.calls.some(([message]) => String(message).includes('Idle database connection')) ? true : undefined,
        ),
      );
      const rows = await victim.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(rows).toEqual([{ ok: 1 }]);
    } finally {
      warn.mockRestore();
    }
  });
});
