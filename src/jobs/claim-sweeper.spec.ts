import { Logger } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service';
import { Claimable, ClaimSweeper } from './claim-sweeper';

/**
 * A stand-in for PrismaService: two tenants, and per tenant the rows the two
 * sweep queries return (stale claims first, then lost pending rows).
 */
function fakePrisma(rows: Record<string, [{ id: string }[], { id: string }[]]>, events: string[]) {
  return {
    tenant: { findMany: () => Promise.resolve(Object.keys(rows).map((id) => ({ id }))) },
    inTenant: async <T>(tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const [stale, lost] = rows[tenantId];
      const results = [stale, lost];
      const tx = { $queryRaw: () => Promise.resolve(results.shift()) };
      const value = await fn(tx);
      events.push(`commit ${tenantId}`);
      return value;
    },
  } as unknown as PrismaService;
}

function claimable(requeue: Claimable['requeue']): Claimable {
  return {
    table: 'notification',
    pending: 'pending',
    claimed: 'dispatching',
    lostAfterMs: 60_000,
    staleAfterMs: 300_000,
    requeue,
  };
}

describe('ClaimSweeper', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requeues stale claims and lost pending rows, after the transaction', async () => {
    const events: string[] = [];
    const sweeper = new ClaimSweeper(
      fakePrisma({ a: [[{ id: 's1' }], [{ id: 's1' }, { id: 'l1' }]], b: [[], [{ id: 'l2' }]] }, events),
    );
    sweeper.register(
      claimable((tenantId, id) => {
        events.push(`requeue ${tenantId} ${id}`);
        return Promise.resolve();
      }),
    );

    await expect(sweeper.sweep()).resolves.toBe(3);
    // s1 is both stale and old enough to count as lost: requeued once.
    expect(events).toEqual(['commit a', 'requeue a s1', 'requeue a l1', 'commit b', 'requeue b l2']);
  });

  it("a requeue that throws doesn't stop the others", async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const requeued: string[] = [];
    const sweeper = new ClaimSweeper(fakePrisma({ a: [[], [{ id: 'x' }, { id: 'y' }]] }, []));
    sweeper.register(
      claimable((_tenantId, id) => {
        if (id === 'x') {
          return Promise.reject(new Error('queue down'));
        }
        requeued.push(id);
        return Promise.resolve();
      }),
    );

    await expect(sweeper.sweep()).resolves.toBe(1);
    expect(requeued).toEqual(['y']);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
